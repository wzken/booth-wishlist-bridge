# BOOTH 收藏分类桥接

让本机命令行或其他大模型批量读取 BOOTH 收藏，并把商品加入 BOOTH 原生私有收藏分组。模型可读取导出的 JSON 自行决定分类；本工具不自动猜测分类。

## 首次使用

需要 Node.js 18 或更新版本、Chrome 与 Tampermonkey。

1. 在本目录运行 `node booth-bridge.mjs setup`。它会生成随机本机令牌和 `booth-bridge.local.user.js`。
2. 把 **生成的** `booth-bridge.local.user.js` 导入 Tampermonkey 并启用。请勿直接导入仓库中的 `booth-bridge.user.js` 模板。
3. 登录 BOOTH，打开 `https://accounts.booth.pm/wish_lists`。
4. 在一个终端运行 `node booth-bridge.mjs serve`，保持终端打开。
5. 在另一个终端运行 `node booth-bridge.mjs status` 检查连接，再运行 `node booth-bridge.mjs backup` 保存完整备份。

如果以前安装过旧版用户脚本，先在 Tampermonkey 删除或禁用旧版，再导入新生成的脚本。以后更新模板时，重新运行 `setup` 并重新导入生成的脚本；已有令牌和备份标记会保留。

## 常用命令

```powershell
node booth-bridge.mjs backup
node booth-bridge.mjs scan favorites.json
node booth-bridge.mjs lists
node booth-bridge.mjs create-list "3D衣装"
node booth-bridge.mjs item-lists 8764340
node booth-bridge.mjs add-items "3D衣装" ids.json
```

`backup` 默认保存到 `backups/booth-时间.json`，也可指定文件名。它包含完整收藏商品信息及全部分组的商品 ID、名称、代码和 BOOTH 返回的分组元数据。第一次执行 `create-list` 或 `add-items` 时，如还没有有效备份，会自动先备份；备份未成功保存就不会修改 BOOTH。手动运行 `backup` 可随时保存新快照。

`scan` 输出可供模型分类的商品信息。`ids.json` 是 ID 数组，例如 `[8764340,8870044]`。`add-items` 分批写入、读回核验，不会移除商品已有的分组；失败项会出现在 `failed` 中。

本机服务只监听 `127.0.0.1:8765`。生成的脚本、配置、收藏导出和备份属于个人数据，不要上传 GitHub；仓库的 `.gitignore` 已排除这些文件。源代码模板没有真实令牌。

## 给大模型的操作顺序

先运行 `status`、`backup`、`scan`、`lists`；结合商品名称和类别设计分组，将每组 ID 写成单独的 JSON 数组；运行 `create-list` 和 `add-items`；最后再次用 `lists`、`item-lists` 或备份结果核对。

该工具使用 BOOTH 页面自身的接口。若 BOOTH 改版，需重新核对接口。
