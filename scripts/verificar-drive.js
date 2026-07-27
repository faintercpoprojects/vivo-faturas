const { drive } = require('../src/uploadDrive');
const { config } = require('../src/config');
async function filhos(id){ const r=await drive().files.list({q:`'${id}' in parents and trashed=false`, fields:'files(id,name,mimeType)', supportsAllDrives:true, includeItemsFromAllDrives:true, pageSize:100}); return r.data.files||[]; }
const PASTA='application/vnd.google-apps.folder';
(async()=>{
  async function arvore(id, prefixo, prof){
    if(prof>4) return;
    const its=(await filhos(id)).sort((a,b)=>a.name.localeCompare(b.name));
    for(const it of its){
      const isF=it.mimeType===PASTA;
      console.log(prefixo+(isF?'📁 ':'📄 ')+it.name);
      if(isF) await arvore(it.id, prefixo+'   ', prof+1);
    }
  }
  console.log('Contas Telefonia/');
  await arvore(config.drive.rootFolderId, '   ', 0);
})().catch(e=>{console.error('Falhou:',e.message);process.exit(1);});
