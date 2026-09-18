// 服务端 CLI 参数解析：--port（默认 8417）/--no-open/--data-dir（测试用，覆盖 panel 数据目录根）。
export const DEFAULT_SERVER_PORT = 8417;

export interface ServerCliArgs {
  port: number;
  noOpen: boolean;
  dataDir: string | null;
  help: boolean;
}

export const SERVER_USAGE = "usage: server.mjs [--port <port>] [--no-open] [--data-dir <dir>]";

/** 拆分 --name=value 形式；返回 [name, value?]，value 为 undefined 表示没有内联值。 */
function splitInlineOption(arg: string): [name: string, inlineValue: string | undefined] {
  const equalsAt = arg.indexOf("=");
  return equalsAt === -1 ? [arg, undefined] : [arg.slice(0, equalsAt), arg.slice(equalsAt + 1)];
}

export function parseServerArgs(argv: readonly string[]): ServerCliArgs {
  const args: ServerCliArgs = {
    port: DEFAULT_SERVER_PORT,
    noOpen: false,
    dataDir: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const [name, inlineValue] = splitInlineOption(arg);
    const nextValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`missing value for ${name}`);
      }
      index += 1;
      return next;
    };
    switch (name) {
      case "--port": {
        const raw = nextValue();
        const port = Number(raw);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error(`invalid port: ${raw}`);
        }
        args.port = port;
        break;
      }
      case "--no-open":
        if (inlineValue !== undefined) throw new Error("--no-open does not take a value");
        args.noOpen = true;
        break;
      case "--data-dir": {
        const dataDir = nextValue();
        if (!dataDir) throw new Error("missing value for --data-dir");
        args.dataDir = dataDir;
        break;
      }
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return args;
}
