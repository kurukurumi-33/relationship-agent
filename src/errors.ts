/**
 * 权限边界拦下的调用：跨人读取、跨人引用。
 *
 * 用类型而不是错误文案来区分，是因为统计要依赖它。pi 会把工具抛出的异常
 * 转成 isError 的 tool_result（只剩文案），所以外层必须在工具执行处按类型计数。
 * 靠正则匹配文案的话，谁改一句提示语，越界计数就静默归零。
 */
export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionDeniedError";
  }
}