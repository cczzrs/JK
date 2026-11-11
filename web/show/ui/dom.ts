/**
 * 页面元素的查找与模板复制。元素和模板都写在 HTML 中；脚本只查找、复制模板并填充数据，不拼接 HTML。
 */

type Ctor<T extends Element> = { new (): T; prototype: T };

export function need<T extends Element = HTMLElement>(root: ParentNode, selector: string, type?: Ctor<T>): T {
  const element = root.querySelector(selector);
  if (!element) throw new Error(`页面缺少元素 ${selector}`);
  if (type && !(element instanceof type)) throw new Error(`元素 ${selector} 不是 ${type.name}`);
  return element as T;
}

export function byId<T extends Element = HTMLElement>(id: string, type?: Ctor<T>): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`页面缺少元素 #${id}`);
  if (type && !(element instanceof type)) throw new Error(`元素 #${id} 不是 ${type.name}`);
  return element as unknown as T;
}

/** 复制 <template id> 中的第一个元素。 */
export function clone<T extends Element = HTMLElement>(templateId: string): T {
  const first = byId(templateId, HTMLTemplateElement).content.firstElementChild;
  if (!first) throw new Error(`模板 #${templateId} 为空`);
  return first.cloneNode(true) as T;
}

/** 复制 template 元素中的第一个元素。 */
export function cloneFrom<T extends Element = HTMLElement>(template: HTMLTemplateElement): T {
  const first = template.content.firstElementChild;
  if (!first) throw new Error("模板为空");
  return first.cloneNode(true) as T;
}

/** 设置元素 #id 的文字；没有这个元素时不做事。 */
export function setText(id: string, text: unknown): void {
  const element = document.getElementById(id);
  if (element) element.textContent = String(text);
}

/** 两格缩进的 JSON 文本（显示用）。 */
export function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
