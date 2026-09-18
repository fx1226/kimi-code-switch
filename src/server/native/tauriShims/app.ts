// @tauri-apps/api/app 的 Node shim：getVersion 返回构建时注入的 package.json 版本号。
import { serverVersion } from "../../runtime";

export async function getVersion(): Promise<string> {
  return serverVersion;
}
