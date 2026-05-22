import * as fs from "fs";
import * as mysql from "mysql2";
import { Client as PgClient } from "pg";
import { DatabaseDriver, IConnection, normalizeDriver } from "../model/connection";

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

export class DbDriver {
    public static createConnection(options: IConnection): any {
        const driver = getDriver(options);

        switch (driver) {
            case "postgresql": {
                const client = new PgClient({
                    host: options.host,
                    port: parseInt(options.port || getDefaultPort(driver), 10),
                    user: options.user,
                    password: options.password || "",
                    database: options.database || "postgres",
                    ssl: options.certPath && fs.existsSync(options.certPath)
                        ? { ca: fs.readFileSync(options.certPath) }
                        : undefined,
                });
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
        const connection = DbDriver.createConnection(options);

        try {
            switch (driver) {
                case "postgresql": {
                    const client = connection.raw as PgClient;
                    if (!connection._connected) {
                        await client.connect();
                    }
                    const result = await client.query(sql);
                    await client.end();
                    return result.rows as any;
                }
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
        const connection = DbDriver.createConnection(options);

        try {
            switch (driver) {
                case "postgresql": {
                    const client = connection.raw as PgClient;
                    await client.connect();
                    const result = await client.query(sql);
                    await client.end();
                    return result.rows;
                }
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
                    "SELECT datname AS name FROM pg_database WHERE datistemplate = false ORDER BY datname");
                return rows.map((row) => row.name || row.datname);
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
            database,
        };
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
