import * as fs from "fs";
import * as net from "net";
import * as mysql from "mysql2";
import { Client as PgClient } from "pg";
import { DatabaseDriver, IConnection, normalizeDriver, normalizeSslMode } from "../model/connection";
import { OutputChannel } from "./outputChannel";

export interface TableInfo {
    TABLE_NAME: string;
    TABLE_COMMENT: string;
}

function getDriver(options: IConnection): DatabaseDriver {
    return normalizeDriver(options.driver);
}

function isFileDriver(driver: DatabaseDriver): boolean {
    return driver === "sqlite" || driver === "duckdb";
}

function getDefaultPort(driver: DatabaseDriver): string {
    switch (driver) {
        case "postgresql":
            return "5432";
        case "mysql":
        default:
            return "3306";
    }
}

function createPostgresClient(options: IConnection): PgClient {
    const mode = normalizeSslMode(options.sslMode);
    const port = parseInt(options.port || getDefaultPort("postgresql"), 10);
    const database = options.database || "postgres";
    const baseConfig = {
        host: options.host,
        port,
        user: options.user,
        password: options.password || "",
        database,
    };

    logPostgresDebug("create client", options, { mode, sslEnabled: mode !== "disable" });

    if (mode === "disable") {
        return new PgClient({ ...baseConfig, ssl: false });
    }

    const ssl: any = mode === "verify-ca"
        ? { rejectUnauthorized: true }
        : { rejectUnauthorized: false };

    if (options.certPath && fs.existsSync(options.certPath)) {
        ssl.ca = fs.readFileSync(options.certPath).toString();
    }

    logPostgresDebug("ssl config", options, {
        mode,
        sslEnabled: true,
        rejectUnauthorized: ssl.rejectUnauthorized,
        hasCa: !!ssl.ca,
    });

    return new PgClient({ ...baseConfig, ssl });
}

function logPostgresDebug(stage: string, options: IConnection, extra?: any): void {
    const certPath = options.certPath || "";
    const payload = {
        stage,
        host: options.host,
        port: options.port || getDefaultPort("postgresql"),
        database: options.database || "postgres",
        user: options.user,
        sslMode: normalizeSslMode(options.sslMode),
        certPath: certPath ? "set" : "empty",
        certExists: certPath ? fs.existsSync(certPath) : false,
        ...extra,
    };
    OutputChannel.appendLine("[PostgreSQL Debug] " + JSON.stringify(payload));
}

function getErrorMessage(err: any): string {
    if (typeof err === "string") {
        return err;
    }
    if (err && err.message) {
        return err.message;
    }
    return String(err);
}

function shouldRetryWithSsl(err: any): boolean {
    const message = getErrorMessage(err);
    // pg_hba 拒绝明文 / 服务器在 startup 后直接关闭 / TCP reset
    // 这些场景下应尝试启用 SSL（类似 libpq 的 sslmode=prefer 行为）
    return (/no pg_hba\.conf entry/i.test(message) && /no encryption/i.test(message))
        || /Connection terminated unexpectedly/i.test(message)
        || /ECONNRESET/i.test(message);
}

function isPostgresSslUnsupportedError(err: any): boolean {
    const message = getErrorMessage(err);
    return /does not support SSL/i.test(message)
        || /server does not support ssl/i.test(message);
}

function closePostgresClient(client: PgClient): void {
    try {
        client.end().catch(() => undefined);
    } catch {
        // ignore close errors
    }
}

async function connectPostgresClient(options: IConnection): Promise<PgClient> {
    const mode = normalizeSslMode(options.sslMode);
    const client = createPostgresClient(options);
    try {
        await client.connect();
        logPostgresDebug("connected", options, {
            mode,
            streamEncrypted: !!((client as any).connection && (client as any).connection.stream && (client as any).connection.stream.encrypted),
        });
        return client;
    } catch (err) {
        closePostgresClient(client);
        logPostgresDebug("connect failed", options, {
            mode,
            error: typeof err === "string" ? err : (err && (err as Error).message) ? (err as Error).message : String(err),
        });

        if (mode === "disable" && shouldRetryWithSsl(err)) {
            try {
                return await retryPostgresConnect(options, "require", "server closed plaintext connection");
            } catch (retryErr) {
                // 如果 SSL 重试得到 "does not support SSL"，说明服务器既不接受明文、SSL 又不支持，
                // 抛出原始错误更具诊断价值
                if (isPostgresSslUnsupportedError(retryErr)) {
                    throw err;
                }
                throw retryErr;
            }
        }

        if (mode !== "disable" && isPostgresSslUnsupportedError(err)) {
            return await retryPostgresConnect(options, "disable", "server does not support SSL");
        }

        throw err;
    }
}

async function retryPostgresConnect(
    options: IConnection,
    newMode: "disable" | "require",
    reason: string,
): Promise<PgClient> {
    const retryOptions = { ...options, sslMode: newMode };
    logPostgresDebug("retry", retryOptions, { reason, newMode });
    const retryClient = createPostgresClient(retryOptions);
    try {
        await retryClient.connect();
        logPostgresDebug("retry connected", retryOptions, {
            streamEncrypted: !!(
                (retryClient as any).connection &&
                (retryClient as any).connection.stream &&
                (retryClient as any).connection.stream.encrypted
            ),
        });
        return retryClient;
    } catch (retryErr) {
        closePostgresClient(retryClient);
        logPostgresDebug("retry failed", retryOptions, {
            error: typeof retryErr === "string"
                ? retryErr
                : (retryErr && (retryErr as Error).message) ? (retryErr as Error).message : String(retryErr),
        });
        throw retryErr;
    }
}

export class DbDriver {
    public static createConnection(options: IConnection): any {
        const driver = getDriver(options);

        switch (driver) {
            case "postgresql": {
                const client = createPostgresClient(options);
                return { driver, raw: client, _connected: false };
            }
            case "sqlite": {
                const Database = require("better-sqlite3");
                const filePath = options.filePath || options.host;
                if (!filePath) {
                    throw new Error("SQLite 需要指定数据库文件路径");
                }
                const db = new Database(filePath, { readonly: false });
                return { driver, raw: db };
            }
            case "duckdb": {
                const duckdb = require("duckdb");
                const filePath = options.filePath || options.host || ":memory:";
                const db = new duckdb.Database(filePath);
                const conn = db.connect();
                return { driver, raw: conn, db };
            }
            case "mysql":
            default: {
                const newConnectionOptions: any = Object.assign({}, options);
                if (options.certPath && fs.existsSync(options.certPath)) {
                    newConnectionOptions.ssl = {
                        ca: fs.readFileSync(options.certPath),
                    };
                }
                newConnectionOptions.flags = "+MYSQL_OPT_ALLOW_ENCRYPTED_CONNECTION";
                return { driver: "mysql", raw: mysql.createConnection(newConnectionOptions) };
            }
        }
    }

    public static async queryPromise<T>(options: IConnection, sql: string): Promise<T> {
        const driver = getDriver(options);
        if (driver === "postgresql") {
            const client = await connectPostgresClient(options);
            try {
                const result = await client.query(sql);
                await client.end();
                return result.rows as any;
            } catch (err) {
                closePostgresClient(client);
                throw err;
            }
        }

        const connection = DbDriver.createConnection(options);

        try {
            switch (driver) {
                case "sqlite": {
                    const db = connection.raw;
                    const trimmed = sql.trim();
                    const isSelect = /^(SELECT|WITH|PRAGMA|SHOW)/i.test(trimmed);
                    if (isSelect) {
                        return db.prepare(sql).all() as any;
                    }
                    db.exec(sql);
                    return [] as any;
                }
                case "duckdb": {
                    return new Promise<T>((resolve, reject) => {
                        connection.raw.all(sql, (err: Error | null, rows: T) => {
                            if (connection.db) {
                                connection.db.close();
                            }
                            if (err) {
                                reject("Error: " + err.message);
                            } else {
                                resolve(rows);
                            }
                        });
                    });
                }
                case "mysql":
                default:
                    return new Promise<T>((resolve, reject) => {
                        connection.raw.query(sql, (err: Error | null, rows: T) => {
                            connection.raw.end();
                            if (err) {
                                reject("Error: " + err.message);
                            } else {
                                resolve(rows);
                            }
                        });
                    });
            }
        } catch (err) {
            DbDriver.safeClose(connection);
            throw err;
        }
    }

    public static async executeQuery(options: IConnection, sql: string): Promise<any> {
        const driver = getDriver(options);
        if (driver === "postgresql") {
            const client = await connectPostgresClient(options);
            try {
                const result = await client.query(sql);
                await client.end();
                return result.rows;
            } catch (err) {
                closePostgresClient(client);
                throw err;
            }
        }

        const connection = DbDriver.createConnection(options);

        try {
            switch (driver) {
                case "sqlite": {
                    const db = connection.raw;
                    const trimmed = sql.trim();
                    const statements = DbDriver.splitStatements(trimmed);
                    let lastResult: any = [];
                    for (const statement of statements) {
                        if (!statement) {
                            continue;
                        }
                        if (/^(SELECT|WITH|PRAGMA|SHOW)/i.test(statement)) {
                            lastResult = db.prepare(statement).all();
                        } else {
                            db.exec(statement);
                            lastResult = { affectedRows: db.prepare("SELECT changes() AS affectedRows").get() };
                        }
                    }
                    return lastResult;
                }
                case "duckdb": {
                    return new Promise<any>((resolve, reject) => {
                        connection.raw.all(sql, (err: Error | null, rows: any) => {
                            if (connection.db) {
                                connection.db.close();
                            }
                            if (err) {
                                reject(err);
                            } else {
                                resolve(rows);
                            }
                        });
                    });
                }
                case "mysql":
                default:
                    return new Promise<any>((resolve, reject) => {
                        connection.raw.query(sql, (err: Error | null, rows: any) => {
                            connection.raw.end();
                            if (err) {
                                reject(err);
                            } else {
                                resolve(rows);
                            }
                        });
                    });
            }
        } catch (err) {
            DbDriver.safeClose(connection);
            throw err;
        }
    }

    public static async listDatabases(options: IConnection): Promise<string[]> {
        const driver = getDriver(options);

        switch (driver) {
            case "postgresql": {
                const rows = await DbDriver.queryPromise<any[]>(options,
                    "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname");
                return rows
                    .map((row) => row.datname || row.name || row.DATNAME)
                    .filter((name) => !!name);
            }
            case "sqlite": {
                const filePath = options.filePath || options.host;
                const name = filePath ? pathBasename(filePath) : "main";
                return [name];
            }
            case "duckdb": {
                try {
                    const rows = await DbDriver.queryPromise<any[]>(options, "SHOW DATABASES");
                    return rows.map((row) => row.database_name || row.name || (row as any)[Object.keys(row)[0]]);
                } catch {
                    return ["main"];
                }
            }
            case "mysql":
            default: {
                const rows = await DbDriver.queryPromise<any[]>(options, "SHOW DATABASES");
                const systemDatabases = ["information_schema", "mysql", "performance_schema", "sys"];
                return rows
                    .map((row) => row.Database)
                    .filter((name) => !systemDatabases.includes(name));
            }
        }
    }

    public static async listTables(options: IConnection, database: string): Promise<TableInfo[]> {
        const driver = getDriver(options);
        const maxCount = 500;

        switch (driver) {
            case "postgresql": {
                const connOpts = { ...options, database };
                const rows = await DbDriver.queryPromise<any[]>(connOpts,
                    `SELECT table_name AS "TABLE_NAME", obj_description(c.oid, 'pg_class') AS "TABLE_COMMENT"
                     FROM information_schema.tables t
                     LEFT JOIN pg_class c ON c.relname = t.table_name
                     WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
                     ORDER BY t.table_name
                     LIMIT ${maxCount}`);
                return rows.map((row) => ({
                    TABLE_NAME: row.TABLE_NAME || row.table_name,
                    TABLE_COMMENT: row.TABLE_COMMENT || "",
                }));
            }
            case "sqlite": {
                const rows = await DbDriver.queryPromise<any[]>(options,
                    `SELECT name AS TABLE_NAME, '' AS TABLE_COMMENT
                     FROM sqlite_master
                     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                     ORDER BY name
                     LIMIT ${maxCount}`);
                return rows;
            }
            case "duckdb": {
                const rows = await DbDriver.queryPromise<any[]>(options,
                    `SELECT table_name AS TABLE_NAME, '' AS TABLE_COMMENT
                     FROM information_schema.tables
                     WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
                     ORDER BY table_name
                     LIMIT ${maxCount}`);
                return rows.map((row) => ({
                    TABLE_NAME: row.TABLE_NAME || row.table_name,
                    TABLE_COMMENT: "",
                }));
            }
            case "mysql":
            default: {
                const connOpts = { ...options, database };
                return DbDriver.queryPromise<TableInfo[]>(connOpts,
                    `SELECT TABLE_NAME, TABLE_COMMENT
                     FROM information_schema.TABLES
                     WHERE TABLE_SCHEMA = '${database.replace(/'/g, "''")}'
                     LIMIT ${maxCount}`);
            }
        }
    }

    public static async listColumns(options: IConnection, database: string, table: string): Promise<any[]> {
        const driver = getDriver(options);
        const safeTable = table.replace(/'/g, "''");
        const safeDatabase = database.replace(/'/g, "''");

        switch (driver) {
            case "sqlite": {
                const rows = await DbDriver.queryPromise<any[]>(options, `PRAGMA table_info('${safeTable}')`);
                return rows.map((row) => ({
                    COLUMN_NAME: row.name,
                    COLUMN_TYPE: row.type,
                    COLUMN_COMMENT: "",
                    IS_NULLABLE: row.notnull ? "NO" : "YES",
                    COLUMN_KEY: row.pk ? "PRI" : "",
                }));
            }
            case "postgresql":
            case "duckdb": {
                const connOpts = { ...options, database };
                return DbDriver.queryPromise<any[]>(connOpts,
                    `SELECT column_name AS "COLUMN_NAME", data_type AS "COLUMN_TYPE", '' AS "COLUMN_COMMENT",
                            is_nullable AS "IS_NULLABLE", '' AS "COLUMN_KEY"
                     FROM information_schema.columns
                     WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
                       AND table_name = '${safeTable}'
                     ORDER BY ordinal_position`);
            }
            case "mysql":
            default: {
                const connOpts = { ...options, database };
                return DbDriver.queryPromise<any[]>(connOpts,
                    `SELECT * FROM information_schema.columns
                     WHERE table_schema = '${safeDatabase}' AND table_name = '${safeTable}'
                     ORDER BY ORDINAL_POSITION`);
            }
        }
    }

    public static getConnectionOptionsFromNode(
        host: string,
        user: string,
        password: string,
        port: string,
        certPath: string,
        driver: DatabaseDriver = "mysql",
        filePath?: string,
        database?: string,
        sslMode?: IConnection["sslMode"],
    ): IConnection {
        if (isFileDriver(driver)) {
            return {
                driver,
                host: filePath || host,
                user: user || "",
                password,
                port: port || "",
                certPath: certPath || "",
                filePath: filePath || host,
                database,
            };
        }
        return {
            driver,
            host,
            user,
            password,
            port: port || getDefaultPort(driver),
            certPath: certPath || "",
            sslMode: driver === "postgresql" ? normalizeSslMode(sslMode) : sslMode,
            database,
        };
    }

    public static async testConnection(options: IConnection): Promise<void> {
        const driver = getDriver(options);
        switch (driver) {
            case "sqlite":
            case "duckdb":
                await DbDriver.listDatabases(options);
                break;
            case "postgresql":
                try {
                    await DbDriver.queryPromise(options, "SELECT 1");
                    await DbDriver.logPostgresServerSslStatus(options);
                } catch (err) {
                    // 失败时做一次 TCP 级别诊断，帮助定位是网络/防火墙/服务端问题
                    await diagnosePostgresTcp(options).catch(() => undefined);
                    throw err;
                }
                break;
            case "mysql":
            default:
                await DbDriver.queryPromise(options, "SELECT 1");
                break;
        }
    }

    private static async logPostgresServerSslStatus(options: IConnection): Promise<void> {
        try {
            const rows = await DbDriver.queryPromise<any[]>(options,
                "SELECT ssl, version, cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid()");
            OutputChannel.appendLine("[PostgreSQL Debug] server ssl status " + JSON.stringify(rows && rows[0] ? rows[0] : rows));
        } catch (err) {
            OutputChannel.appendLine("[PostgreSQL Debug] server ssl status unavailable: " +
                (err && (err as Error).message ? (err as Error).message : String(err)));
        }
    }

    private static splitStatements(sql: string): string[] {
        return sql
            .split(";")
            .map((part) => part.trim())
            .filter((part) => part.length > 0);
    }

    private static safeClose(connection: any): void {
        try {
            if (!connection) {
                return;
            }
            if (connection.driver === "mysql" && connection.raw) {
                connection.raw.end();
            } else if (connection.driver === "postgresql" && connection.raw) {
                connection.raw.end().catch(() => undefined);
            } else if (connection.driver === "sqlite" && connection.raw) {
                connection.raw.close();
            } else if (connection.driver === "duckdb" && connection.db) {
                connection.db.close();
            }
        } catch {
            // ignore close errors
        }
    }
}

function pathBasename(filePath: string): string {
    const parts = filePath.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] || "main";
}

/**
 * 原始 TCP 探测：建立连接后发送 PostgreSQL SSLRequest 包，记录服务器返回的字节及连接状态。
 * 用于定位 "Connection terminated unexpectedly" 类问题的根因。
 */
function diagnosePostgresTcp(options: IConnection): Promise<void> {
    return new Promise((resolve) => {
        const host = options.host;
        const port = parseInt(options.port || getDefaultPort("postgresql"), 10);
        const startTime = Date.now();
        const events: string[] = [];
        const socket = new net.Socket();
        let bytesReceived = 0;
        let firstBytes = "";

        const finish = (extra: any) => {
            OutputChannel.appendLine("[PostgreSQL TCP Diagnose] " + JSON.stringify({
                host,
                port,
                elapsedMs: Date.now() - startTime,
                events,
                bytesReceived,
                firstBytes,
                ...extra,
            }));
            try { socket.destroy(); } catch { /* ignore */ }
            resolve();
        };

        const timer = setTimeout(() => finish({ reason: "diagnose timeout (5s)" }), 5000);

        socket.on("connect", () => {
            events.push(`connect@${Date.now() - startTime}ms`);
            // PostgreSQL SSLRequest packet: length=8, code=80877103 (1234.5679)
            const buf = Buffer.alloc(8);
            buf.writeInt32BE(8, 0);
            buf.writeInt32BE(80877103, 4);
            socket.write(buf);
            events.push(`sent SSLRequest@${Date.now() - startTime}ms`);
        });

        socket.on("data", (data: Buffer) => {
            bytesReceived += data.length;
            if (firstBytes.length < 32) {
                firstBytes += data.toString("hex");
            }
            events.push(`data(${data.length}B,first=0x${data[0].toString(16)})@${Date.now() - startTime}ms`);
        });

        socket.on("close", (hadErr: boolean) => {
            events.push(`close(hadErr=${hadErr})@${Date.now() - startTime}ms`);
            clearTimeout(timer);
            finish({});
        });

        socket.on("error", (err: Error) => {
            events.push(`error(${err.message})@${Date.now() - startTime}ms`);
        });

        socket.on("timeout", () => {
            events.push(`timeout@${Date.now() - startTime}ms`);
        });

        socket.setTimeout(3000);
        try {
            socket.connect(port, host);
        } catch (err) {
            events.push(`connect-throw(${(err as Error).message})`);
            clearTimeout(timer);
            finish({});
        }
    });
}
