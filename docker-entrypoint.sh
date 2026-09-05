#!/bin/sh
set -e
echo "waiting for mongodb on 127.0.0.1:27017"
i=0
while [ "$i" -lt 60 ]; do
  if node -e "const n=require('net'); const s=n.connect({host:'127.0.0.1',port:27017},()=>{s.end();process.exit(0)}); s.on('error',()=>process.exit(1))"; then
    echo "mongodb is up"
    break
  fi
  i=$((i + 1))
  sleep 1
done

echo "waiting for outbound internet via tailscale exit node"
i=0
while [ "$i" -lt 45 ]; do
  if node -e "require('https').get('https://discord.com/api/v10/gateway',r=>{r.resume();process.exit(0)}).on('error',()=>process.exit(1))"; then
    echo "internet is up"
    break
  fi
  i=$((i + 1))
  sleep 2
done

exec node bot.js
