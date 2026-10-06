// 内置降级渲染页（隐藏窗口）：docx / xlsx → HTML，随后由主进程 printToPDF 转成 PDF。
// 状态约定：渲染完成后写 window.__officeRenderState = 'done' 或 'error: 原因'，主进程轮询取用。
// 说明：这是「没装 LibreOffice 加装包」时的兜底路径；文本类文档效果较好，复杂版式会有偏差。
const params = new URLSearchParams(location.search);
const filePath = params.get('file') || '';
const kind = params.get('kind') === 'xlsx' ? 'xlsx' : 'docx';

const content = document.getElementById('content');
const statusEl = document.getElementById('status');

/** 等所有图片加载完再交付打印（docx 里的图片是 blob URL，渲染完成 ≠ 图片已解码） */
async function waitImages() {
  const images = [...document.images];
  await Promise.all(
    images.map((img) => (img.complete
      ? Promise.resolve()
      : new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      })))
  );
}

async function renderDocx(bytes) {
  if (!window.docx || typeof window.docx.renderAsync !== 'function') {
    throw new Error('docx-preview 加载失败');
  }
  await window.docx.renderAsync(bytes, content, null, {
    breakPages: true,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    inWrapper: true
  });
}

function renderWorkbook(bytes) {
  if (!window.XLSX) throw new Error('SheetJS 加载失败');
  const wb = window.XLSX.read(bytes, { type: 'array' });
  if (!wb.SheetNames || wb.SheetNames.length === 0) throw new Error('工作簿里没有工作表');
  for (const name of wb.SheetNames) {
    const section = document.createElement('section');
    section.className = 'xlsx-sheet';
    const heading = document.createElement('h2');
    heading.textContent = name;
    section.appendChild(heading);
    const html = window.XLSX.utils.sheet_to_html(wb.Sheets[name], { header: '', footer: '' });
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const table = parsed.querySelector('table');
    if (table) section.appendChild(table);
    content.appendChild(section);
  }
}

(async () => {
  try {
    if (!filePath) throw new Error('缺少文件参数');
    statusEl.textContent = '读取文件…';
    const bytes = await window.desktop.readFile(filePath);
    statusEl.textContent = '渲染中…';
    if (kind === 'xlsx') renderWorkbook(bytes);
    else await renderDocx(bytes);
    await waitImages();
    statusEl.textContent = '';
    window.__officeRenderState = 'done';
  } catch (err) {
    window.__officeRenderState = `error: ${(err && err.message) || err}`;
    statusEl.textContent = window.__officeRenderState;
  }
})();