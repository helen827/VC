# GEO Agent Web (本地工具)

一个**适用于任何公司**的本地 Web 工具：输入公司名 + 官网/公众号/知乎等 URL，或直接粘贴强调材料/上传 **Word（.docx）/ PDF / PowerPoint（.pptx）/ Pages（.pages）**，自动生成：

- **GEO 内容包**：官网页面草稿、公众号长文、知乎问答草稿（Markdown）
- **评测/监控包**：问题集 + 打分规则 + 记录模板（用于豆包/千问/DeepSeek 等人工抽检）
- 一键导出为 **zip**

## 使用

1. 安装依赖

```bash
cd geo-agent-web
npm install
```

2. 配置环境变量

```bash
cp .env.example .env
```

至少填写 `LLM_API_KEY`（以及必要时修改 `LLM_BASE_URL`/`LLM_MODEL`）。

3. 启动

```bash
npm run dev
```

打开浏览器访问 `http://localhost:3417`（或你在 `.env` 里配置的端口）。

说明：本工具的 `dev` 脚本默认会先 `build` 再 `start`（不依赖文件监听），以兼容更严格的运行环境。

## 部署到公网（推荐：Render）

前提：把本项目推到 GitHub（Render 需要从 Git 仓库拉代码构建）。

1. 确保 `.env` 里相关变量在云端也能配置（Render 里叫 “Environment Variables”）：

- `ACCESS_TOKEN`：访问密码（例如 `volcanics`）
- `LLM_BASE_URL`
- `LLM_API_KEY`（或 `QINIU_AI_API_KEY`）
- `LLM_MODEL`
- `FETCH_TIMEOUT_MS` / `FETCH_CONCURRENCY`（可选）

2. Render 控制台创建 Web Service：

- Runtime: **Docker**
- Root Directory: `geo-agent-web`
- Auto Deploy: on（可选）

3. 设置端口：

Render 会自动注入 `PORT`，服务会监听该端口；无需手动写死。

4. 访问：

打开你的网站域名，会先看到 “访问密码” 输入框；输入 `ACCESS_TOKEN` 对应的密码即可使用。

## 输出结构（zip）

- `manifest.json`
- `sources/`：抓取/粘贴/Word 的原始文本与元数据（便于溯源）
- `profile/entity_profile.json`：带证据引用的公司画像（机器可读）
- `content/`：可发布内容（Markdown）
- `eval/`：问题集、rubric、记录模板（CSV/JSON）

