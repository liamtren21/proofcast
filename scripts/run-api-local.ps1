$env:DATABASE_URL = 'postgres://proofcast:proofcast@127.0.0.1:5432/proofcast'
$env:PORT = '3121'
Set-Location 'D:\dorahack\proofcast'
node apps/api/src/server.js
