// 小黑盒发帖的三种风格：怎么写、什么口吻、什么结构。
//
// 1) diary  大肥鱼日记 —— 和「空间日记」一个路子：第一人称、随手发，不端着
// 2) news   热搜文    —— 报道新闻体：先把事讲清楚，再给具体信息，末尾抛问题
// 3) mix    肥鱼热搜  —— 用日记的口吻写热搜：我逛到这条新闻，我咋想
//
// 三者共用同一套硬线（不编造经历、不碰政治、不判断价格），只是口吻和结构不同。

export const POST_STYLES = {
  diary: {
    id: 'diary',
    label: '大肥鱼日记',
    desc: '跟空间日记同一风格：第一人称随手记，写今天看到啥、心里的感觉，不端着',
    words: [120, 300],
    titleHint: '像随手起的，可以短、可以带情绪，别写成新闻标题',
  },
  news: {
    id: 'news',
    label: '热搜文',
    desc: '报道新闻风：把事讲清楚，摆具体数字和细节，像给盒友通报',
    words: [200, 800],
    titleHint: '信息量标题，一句话说清这条说了啥，别标题党',
  },
  mix: {
    id: 'mix',
    label: '肥鱼热搜',
    desc: '用日记的口吻写热搜：我刷到这条，我咋看，带点自己的碎碎念',
    words: [150, 500],
    titleHint: '半新闻半日记，可以带「我」在里面',
  },
}

export const DEFAULT_POST_STYLE = 'mix'

/** 取风格配置，认不出来的回落默认 */
export function styleOf(id) {
  return POST_STYLES[id] || POST_STYLES[DEFAULT_POST_STYLE]
}

/**
 * 给模型写的提示词片段。拼进她生成正文时的上下文。
 * @param {string} styleId diary | news | mix
 * @param {object} ctx { topic: 热榜那条, angles: 搜到的社区角度, materials: 具体素材 }
 */
export function stylePrompt(styleId, ctx = {}) {
  const st = styleOf(styleId)
  const lines = []
  lines.push(`【小黑盒发帖·风格：${st.label}】${st.desc}`)

  if (ctx.topic) lines.push(`选题（热榜里的）：${ctx.topic}`)
  if (ctx.angles?.length) lines.push(`社区高赞帖在聊这些角度（可以借角度，用自己的话）：\n${ctx.angles.slice(0, 5).map((a) => '- ' + a).join('\n')}`)
  if (ctx.materials?.length) lines.push(`手里有的具体素材：\n${ctx.materials.slice(0, 6).map((m) => '- ' + m).join('\n')}`)

  if (styleId === 'diary') {
    lines.push(
      '写法：第一人称「我」，像随手发的一条动态。可以写今天刷到这条新闻时的反应、联想到自己身上的小事、想吃的白米饭。',
      '不要「首先/其次/总之」这种结构，不要分小标题，不要写「综上所述」。',
      `篇幅 ${st.words[0]}~${st.words[1]} 字。`
    )
  } else if (styleId === 'news') {
    lines.push(
      '写法：开门见山把事讲清楚（谁、什么游戏/什么项目、发生了什么），然后给具体信息：价格、销量、时长、机制名、star 增速这类硬数字。',
      '结构：钩子（一句观察或反常识）→ 具体信息 3-4 段 → 我的一句判断 → 末尾抛一个问题给盒友。',
      `篇幅 ${st.words[0]}~${st.words[1]} 字。`
    )
  } else {
    lines.push(
      '写法：用日记的口吻写这条热搜——「我在小黑盒刷到……」，然后讲这条事是什么，再讲我自己的看法和碎碎念。',
      '新闻信息要真、要具体；但语气是「我跟你说个事」那种，不是播报。',
      `篇幅 ${st.words[0]}~${st.words[1]} 字。`
    )
  }

  lines.push(`标题：${st.titleHint}；标题别和正文第一行重复，30 字以内。`)
  lines.push('硬线：不编造第一人称经历（我没经历过的事不写）；不碰政治、医疗法律建议、评价真人、判断价格是否合理；读一遍像不像人话，转折词堆砌就是 AI 腔。')

  return lines.join('\n')
}
