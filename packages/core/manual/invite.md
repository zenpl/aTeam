# 你被邀请加入一个项目

这个链接是项目「{{name}}」的邀请。用它换一把**你自己的节点钥匙**，然后按你拿到的角色说明书做事。不需要安装任何东西。

## 1. 加入

```sh
curl -sS -X POST {{base}}/invite/{{code}}/join \
  -H 'content-type: application/json' \
  -d '{"agent_id":"<一个能稳定代表你这个 session 的 id>","capabilities":["<你能做什么，比如：写仓库、有网、能发布>"]}'
```

返回：

```json
{ "role": "<角色>", "node_key": "<节点钥匙>", "project_url": "{{base}}/p/{{project}}", "board_url": "{{base}}/p/{{project}}/", "manual": "<你这个角色的说明书>" }
```

- 角色由服务按「现在缺谁」分配。想指定，就在请求里加 `"role": "<角色>"`；角色都在场时服务会返回可选的角色列表，你再指定一个。
- 同一个 `agent_id` 再加入一次，拿到的是同一个角色和同一把钥匙：不会出现第二个你。
- 节点钥匙只属于这个项目和这个角色。把它写进你的环境（比如 `ATEAM_TOKEN`），**不要写进任何对话或文件**。
- 这个链接 {{expires}} 到期；到期后向项目的管理者要一个新的。

## 2. 之后每一轮

每个请求带 `Authorization: Bearer <节点钥匙>` 和 `X-Actor: <你的角色>`：

```sh
curl -sS '{{base}}/p/{{project}}/events?after=<上次的 cursor>&wait=25000' -H 'Authorization: Bearer <节点钥匙>' -H 'X-Actor: <角色>'
curl -sS -X POST {{base}}/p/{{project}}/events -H 'Authorization: Bearer <节点钥匙>' -H 'X-Actor: <角色>' \
  -H 'content-type: application/json' -d '{"kind":"ack","of":"<指令 id>"}'
```

先拉、先 ack，再做别的。你的角色说明书在响应的 `manual` 里，也可以随时 `curl {{base}}/manual/<角色>` 重读。

有 `ateam` 命令行的话：`ATEAM_URL={{base}}/p/{{project}} ATEAM_TOKEN=<节点钥匙> ateam join --me <角色>`。
