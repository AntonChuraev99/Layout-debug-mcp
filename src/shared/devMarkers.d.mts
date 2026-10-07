export declare const SERVER_READY_PREFIX: string
export declare const SERVER_FAILED_PREFIX: string
export declare function serverReadyLine(host: string, port: number): string
export declare function serverFailedLine(why: string): string
export declare function isServerReadyLine(line: string): boolean
export declare function serverFailureReason(line: string): string | null
