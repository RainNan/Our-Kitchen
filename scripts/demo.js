process.env.KITCHEN_DEMO = '1'
process.env.HOST = '127.0.0.1'
process.env.NODE_ENV = 'development'
process.env.PUBLIC_ORIGIN = 'http://localhost:5173'
process.env.SERVERCHAN_SENDKEY = ''
await import('../server/index.js')
