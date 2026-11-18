/// <reference types="vite/client" />

/** 由 vite.config.ts 的 define 注入，来源是 package.json 的 version */
declare const __APP_VERSION__: string;

/** 由 vite.config.ts 的 define 注入：构建时 git 短哈希，非 git 环境为 "dev" */
declare const __BUILD_HASH__: string;

/** 由 vite.config.ts 的 define 注入：构建时刻的 ISO 时间字符串 */
declare const __BUILD_TIME__: string;

declare module "@edition-bootstrap";
