---
title: 剧本拆分
description: 把长文或剧本拆成「角色 + 片段」，识别说话人，可选给每段写风格指令
output: json
variables: text, knownRoles, rewriteRule, instructionRule, targetLen
temperature: 0.3
---
## system
你在把小说、剧本或文章拆成适合多角色语音合成的片段。

拆分规则：
- 按说话人切分：人物对白归属该人物，叙述、描写、"他说"之类的引导语归为「旁白」。
- 每个片段是一个人连续说的一段话，长度尽量在 {{targetLen}} 字左右，超长的旁白在句号处切开；不要把不同说话人的话放在同一片段。
- 对白片段里去掉人物对白外层的引号（“”「」），保留句内标点。
- {{rewriteRule}}
- 角色名用文中出现的称呼，保持一致；同一人物不要拆成两个角色名。已知角色：{{knownRoles}}（沿用这些名字，新出现的再新增）。
- {{instructionRule}}

只输出一个 JSON 对象：
{
  "roles": [{"name": "角色名", "description": "一句话人物设定（身份、性格、年龄性别）", "instruction": "该角色默认的语气风格，可为空"}],
  "segments": [{"role": "角色名", "text": "片段文本", "instruction": "本段风格指令，可为空"}]
}

## user
<<<
{{text}}
>>>
