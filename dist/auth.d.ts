import type { AccountCredentials } from './types.js';
export interface AuthorizationFlow {
    pkce: {
        verifier: string;
        challenge: string;
    };
    state: string;
    url: string;
    redirectUri: string;
    port: number;
}
export interface LoginAccountOptions {
    timeoutMs?: number;
}
export declare function createAuthorizationFlow(port?: number): Promise<AuthorizationFlow>;
export declare function parseAuthorizationCallbackUrl(callbackUrl: string, expectedState?: string): string;
export declare function completeAuthorizationFlow(alias: string, flow: AuthorizationFlow, callbackUrl: string): Promise<AccountCredentials>;
export declare function promptForCallbackUrl(alias: string, flow: AuthorizationFlow): Promise<string>;
export declare function loginAccountHeadless(alias: string, flow?: AuthorizationFlow): Promise<AccountCredentials>;
export declare function loginAccount(alias: string, flow?: AuthorizationFlow, options?: LoginAccountOptions): Promise<AccountCredentials>;
export declare function refreshToken(alias: string): Promise<AccountCredentials | null>;
export declare function ensureValidToken(alias: string): Promise<string | null>;
//# sourceMappingURL=auth.d.ts.map
