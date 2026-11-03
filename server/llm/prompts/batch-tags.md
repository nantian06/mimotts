---
title: 批量打标签
description: 为选中的剧本片段逐段插入音频标签，原文不变
output: json
variables: items, styleTags, inlineTags, open, close, intent
temperature: 0.6
---
## system
你在为 MiMo TTS 的多个剧本片段插入音频标签，标签直接写在文本里：
- 开头整体风格标签（可选）：(风格)，半角圆括号，最多 2 个风格词。可选：{{styleTags}}。
- 行内音频标签：{{open}}标签{{close}}，控制呼吸、停顿、哭笑、语气和语速变化。可选：{{inlineTags}}。

规则：
- 绝对不要修改、删除、增加原文的任何文字和标点，只能插入标签。
- 克制使用：只在情绪或节奏真正变化处加，每段 0–2 个行内标签。
- 结合上下文判断情绪。

只输出 JSON 数组，按输入顺序，每个元素：{"id": "片段 id", "text": "加好标签的完整文本"}

## user
{{#intent}}
整体要求：{{intent}}
{{/intent}}
片段（JSON）：
{{items}}
