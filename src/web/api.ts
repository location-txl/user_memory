export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`/v1${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionStorage.getItem("umem-token") ?? ""}`,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error ?? `请求失败：${response.status}`);
  return data as T;
}
export const date = (value?: string | null) =>
  value
    ? new Date(value).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "尚无记录";
export const kindNames: Record<string, string> = {
  preference: "偏好",
  constraint: "约束",
  decision: "决策",
  lesson: "经验",
};
export const statusNames: Record<string, string> = {
  active: "生效",
  candidate: "待审核",
  withdrawn: "已撤回",
  pending: "等待提炼",
  running: "提炼中",
  done: "已处理",
  failed: "失败",
};
