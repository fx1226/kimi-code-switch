// Compile-time version only. Node services do not emulate browser globals.
declare const SERVER_VERSION: string;
export const serverVersion = typeof SERVER_VERSION === "string" ? SERVER_VERSION : "0.0.0-dev";
