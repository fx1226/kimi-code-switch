/** Legacy panel metadata only. No bridge process or account management is implemented. */
export interface ChatgptBridgeBinding {
  /** 绑定的 Kimi Code 环境 id（默认 "default"）。 */
  environmentId: string;
  /** GUI 实际创建的 provider 名（createUniqueName 去重后的精确名）。 */
  providerName: string;
  /** GUI 实际创建的模型键（完整 key，如 "chatgpt/gpt-mock-pro"）。 */
  modelAliases: string[];
  /** GUI 实际创建的 profile 名（可选）。 */
  profileName?: string;
  /** 本地桥接监听端口。 */
  bridgePort: number;
  /** 本地桥接访问密钥（loopback 随机值，非 OpenAI token；导出需脱敏）。 */
  bridgeSecret: string;
  createdAt: string;
  lastVerifiedAt?: string;
  lastVerifiedOk?: boolean;
}
