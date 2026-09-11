/**
 * Built-in mail transports.
 */
export type { MailProvider, Letter } from "../types.ts";
export { ConsoleProvider, NullProvider, ExplodingProvider } from "./console.ts";
export { HttpProvider } from "./http.ts";
export type { HttpProviderOptions } from "./http.ts";
