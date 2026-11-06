const [major,minor,patch]=process.versions.node.split('.').map(Number);
const fixed=major===24&&(minor>22||minor===22&&patch>=1)||major===26&&(minor>12||minor===12&&patch>=1);
if(!fixed){console.error(`当前 Node.js ${process.version} 未满足 2026-10-21 安全基线。请安装 Node.js 24.22.1 或更新的 24.x 安全版本，或 26.12.1 或更新的 26.x。`);process.exit(1);}
console.log(`Node.js ${process.version}: security baseline passed`);
