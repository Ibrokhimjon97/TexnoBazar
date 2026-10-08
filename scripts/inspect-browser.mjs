import http from 'http';

http.get('http://127.0.0.1:9222/json', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const list = JSON.parse(data);
    console.log('Open tabs in Chrome:');
    for (const t of list) {
      console.log(`- ${t.title} (${t.url}) [ws: ${t.webSocketDebuggerUrl}]`);
    }
  });
}).on('error', console.error);
