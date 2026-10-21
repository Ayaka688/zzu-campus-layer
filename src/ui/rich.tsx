/**
 * 面板与手机 PWA 共用的轻量渲染件。
 * 回答是模板生成的轻量 markdown，量很小，自己拆比引 markdown 库划算（也避免 XSS）。
 */
import { useState } from 'preact/hooks';

/**
 * 校园地图：需要你自己放一张。
 *
 * 仓库里**不带地图图片**（那是学校的版权素材），所以 `public/map/campus.jpg` 默认不存在。
 * 想用这个功能：把任意手绘图 / 示意图存成 `public/map/campus.jpg` 再重新 build
 * （建议 1000–1400 px 宽、竖版）。图片缺失时这里会安静地不渲染，答案照常出。
 *
 * 用「相对页面」的路径而不是 `/map/...`：扩展页面在 /sidepanel/、PWA 在 /pwa/，
 * 两者都比 dist 根深一层，所以 `../map/campus.jpg` 对两边都成立，
 * 部署到子路径（GitHub Pages 项目页）时也不用改。
 */
export const CAMPUS_MAP = '../map/campus.jpg';

/** 行内 **粗体** → <strong>，其余原样（不解析 HTML，接口内容不当标记执行）。 */
export function inline(text: string): unknown[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((part) => {
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
        return <strong>{part.slice(2, -2)}</strong>;
      }
      return part;
    });
}

/** 整行加粗 = 小标题；"- " = 列表；其余段落。 */
export function RichText({ text }: { text: string }) {
  const nodes: unknown[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length === 0) return;
    nodes.push(
      <ul>
        {list.map((item) => (
          <li>{inline(item)}</li>
        ))}
      </ul>,
    );
    list = [];
  };

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^\s*-\s+/.test(line)) {
      list.push(line.replace(/^\s*-\s+/, ''));
      continue;
    }
    flush();
    const heading = /^\*\*[^*]+\*\*$/.test(line.trim());
    nodes.push(<p class={heading ? 'h' : undefined}>{inline(line)}</p>);
  }
  flush();
  return <div class="md">{nodes}</div>;
}

export function CampusMap() {
  const [open, setOpen] = useState(false);
  const [missing, setMissing] = useState(false);
  if (missing) return null;
  return (
    <figure class={`map${open ? ' open' : ''}`}>
      <img
        src={CAMPUS_MAP}
        alt="校园地图"
        title={open ? '点一下收起' : '点一下看整张地图'}
        onClick={() => setOpen((v) => !v)}
        onError={() => setMissing(true)}
      />
      <figcaption>{open ? '点图收起' : '校园地图 · 点图放大'}</figcaption>
    </figure>
  );
}

/** 触发一次文件下载（面板与手机都用 Blob + a[download]）。 */
export function download(filename: string, content: string, type = 'text/calendar;charset=utf-8'): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
