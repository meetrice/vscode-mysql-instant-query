export type DatabaseDriver = 'mysql' | 'postgresql' | 'sqlite' | 'duckdb';

export function normalizeDriver(driver?: string): DatabaseDriver {
    if (driver === 'postgresql' || driver === 'sqlite' || driver === 'duckdb') {
        return driver;
    }
    return 'mysql';
}

export interface IConnection {
    readonly driver?: DatabaseDriver;
    readonly host: string;
    readonly user: string;
    readonly password?: string;
    readonly port: string;
    readonly database?: string;
    readonly filePath?: string;
    multipleStatements?: boolean;
    readonly certPath: string;
    readonly displayName?: string;
}

export interface IStoredConnection extends IConnection {
    readonly driver: DatabaseDriver;
}
