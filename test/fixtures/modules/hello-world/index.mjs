/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'hello-world',
  name: '打招呼',
  version: '1.0.0',
  api: 1,
  setup(api) {
    api.on('message', async (msg) => {
      if (msg.text !== '你好') return false
      await api.send(msg.chatId, '你好呀～')
      return true
    })
  },
}
