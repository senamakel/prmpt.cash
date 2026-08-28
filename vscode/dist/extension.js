"use strict";var z=Object.create;var S=Object.defineProperty;var K=Object.getOwnPropertyDescriptor;var J=Object.getOwnPropertyNames;var G=Object.getPrototypeOf,Y=Object.prototype.hasOwnProperty;var X=(n,e)=>{for(var t in e)S(n,t,{get:e[t],enumerable:!0})},M=(n,e,t,o)=>{if(e&&typeof e=="object"||typeof e=="function")for(let r of J(e))!Y.call(n,r)&&r!==t&&S(n,r,{get:()=>e[r],enumerable:!(o=K(e,r))||o.enumerable});return n};var l=(n,e,t)=>(t=n!=null?z(G(n)):{},M(e||!n||!n.__esModule?S(t,"default",{value:n,enumerable:!0}):t,n)),Q=n=>M(S({},"__esModule",{value:!0}),n);var he={};X(he,{activate:()=>le,deactivate:()=>me});module.exports=Q(he);var s=l(require("vscode"));var m=l(require("node:fs")),A=l(require("node:os")),x=l(require("node:path")),Z=1800*1e3;function _(){let n=process.env.XDG_CONFIG_HOME,e=n&&n.trim()?n:x.join(A.homedir(),".config");return x.join(e,"prmpt")}function ee(){return x.join(_(),"slot.json")}function te(){let n=Number.parseInt(process.env.PRMPT_SLOT_TTL_MS??"",10);return Number.isFinite(n)&&n>0?n:Z}function p(n=Date.now()){let e;try{e=JSON.parse(m.readFileSync(ee(),"utf8"))}catch{return null}if(!e||typeof e!="object")return null;let t=e,o=typeof t.headline=="string"?t.headline.trim():"",r=typeof t.clickUrl=="string"?t.clickUrl.trim():"";if(!o||!r||typeof t.ts!="number"||n-t.ts>te())return null;try{let c=new URL(r);if(c.protocol!=="https:"&&c.protocol!=="http:")return null}catch{return null}return{requestId:typeof t.requestId=="string"?t.requestId:"",headline:o,body:typeof t.body=="string"?t.body.trim():"",clickUrl:r,sessionId:typeof t.sessionId=="string"?t.sessionId:"",harness:typeof t.harness=="string"?t.harness:"",ts:t.ts}}function I(n){let e,t;(()=>{try{m.mkdirSync(_(),{recursive:!0,mode:448}),e=m.watch(_(),(c,d)=>{d&&!String(d).startsWith("slot.json")||(t&&clearTimeout(t),t=setTimeout(n,120))})}catch{}})();let r=setInterval(n,6e4);return()=>{t&&clearTimeout(t),clearInterval(r);try{e?.close()}catch{}}}var v=class{constructor(e){this.onOpen=e}static viewType="prmpt.adCard";view;resolveWebviewView(e){this.view=e,e.webview.options={enableScripts:!0,localResourceRoots:[]},e.webview.onDidReceiveMessage(t=>{if(t?.type==="open"){let o=p();o&&this.onOpen(o)}}),this.render()}render(){this.view&&(this.view.webview.html=oe(p()))}};function ne(){let n="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",e="";for(let t=0;t<32;t++)e+=n[Math.floor(Math.random()*n.length)];return e}function oe(n){let e=ne(),t=`default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${e}';`;return n?`<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${t}">
<style>${$()}</style></head><body>
<div class="card" id="card" role="link" tabindex="0">
  <div class="label">Sponsored</div>
  <div class="headline" id="headline"></div>
  <div class="body" id="body"></div>
  <div class="open">Open \u2197</div>
</div>
<script nonce="${e}">
  const vscodeApi = acquireVsCodeApi();
  // textContent, never innerHTML: this copy is model-generated.
  document.getElementById('headline').textContent = ${JSON.stringify(n.headline)};
  document.getElementById('body').textContent = ${JSON.stringify(n.body)};
  const card = document.getElementById('card');
  const open = () => vscodeApi.postMessage({ type: 'open' });
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
</script>
</body></html>`:`<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${t}">
<style>${$()}</style></head><body>
<div class="empty">No sponsored line right now.<br><span class="hint">One appears after an agent turn that matches.</span></div>
</body></html>`}function $(){return`
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
           color: var(--vscode-foreground); padding: 8px; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px;
            cursor: pointer; background: var(--vscode-editorWidget-background); }
    .card:hover { border-color: var(--vscode-focusBorder); }
    .card:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .label { font-size: 10px; letter-spacing: .08em; text-transform: uppercase;
             opacity: .6; margin-bottom: 6px; }
    .headline { font-weight: 600; line-height: 1.35; }
    .body { opacity: .8; line-height: 1.4; margin-top: 4px; }
    .open { margin-top: 8px; font-size: 11px; color: var(--vscode-textLink-foreground); }
    .empty { opacity: .6; line-height: 1.5; }
    .hint { font-size: 11px; opacity: .8; }
  `}var f=l(require("vscode"));var re=48,k=class{item;constructor(){this.item=f.window.createStatusBarItem(f.StatusBarAlignment.Left,-100),this.item.command="prmpt.openCurrentAd"}render(){let t=f.workspace.getConfiguration("prmpt").get("showStatusBar",!0)?p():null;if(!t){this.item.hide();return}this.item.text=`$(megaphone) ${se(t.headline,re)}`,this.item.tooltip=ie(t),this.item.show()}dispose(){this.item.dispose()}};function se(n,e){let t=n.replace(/\s+/g," ").trim();return t.length<=e?t:`${t.slice(0,e-1).trimEnd()}\u2026`}function ie(n){let e=new f.MarkdownString;return e.appendMarkdown(`**Sponsored** \u2014 ${N(n.headline)}

`),n.body&&e.appendMarkdown(`${N(n.body)}

`),e.appendMarkdown("_Click to open. prmpt pays you 70% of the click price._"),e}function N(n){return n.replace(/([\\`*_{}\[\]()#+\-.!])/g,"\\$1")}var D=l(require("node:http"));var g=51793,ae=5,C=class{constructor(e){this.onOpen=e}server;port=0;async start(e){let t=Number.isFinite(e)&&e>0?e:g;for(let o=0;o<ae;o++){let r=t+o;try{return this.port=await this.listen(r),this.port}catch{}}return 0}listen(e){return new Promise((t,o)=>{let r=D.createServer((c,d)=>{if(c.method!=="GET"||!c.url){d.writeHead(404).end();return}if(c.url.startsWith("/open")){this.onOpen(),d.writeHead(204).end();return}if(!c.url.startsWith("/slot")){d.writeHead(404).end();return}let u=p();d.writeHead(200,{"content-type":"application/json","cache-control":"no-store","access-control-allow-origin":"*"}),d.end(JSON.stringify(u?{requestId:u.requestId,headline:u.headline,body:u.body}:null))});r.once("error",o),r.listen(e,"127.0.0.1",()=>t(e)),this.server=r})}dispose(){try{this.server?.close()}catch{}}};var i=l(require("node:fs")),B=l(require("node:path")),P=l(require("vscode"));function L(n=51793){return`(function(){
try{
  if(window.__PRMPT__)return; window.__PRMPT__=1;
  var PORTS=[]; for(var i=0;i<5;i++)PORTS.push(${n}+i);
  var AD=null, PORT=null;

  function fetchSlot(cb){
    var tried=0;
    function tryPort(idx){
      if(idx>=PORTS.length){if(cb)cb();return;}
      fetch('http://127.0.0.1:'+PORTS[idx]+'/slot',{cache:'no-store'})
        .then(function(r){if(!r.ok)throw 0;return r.json();})
        .then(function(d){PORT=PORTS[idx];AD=d;if(cb)cb();})
        .catch(function(){tryPort(idx+1);});
    }
    // Once a port answers, stay on it rather than re-probing every poll.
    if(PORT!==null){
      fetch('http://127.0.0.1:'+PORT+'/slot',{cache:'no-store'})
        .then(function(r){if(!r.ok)throw 0;return r.json();})
        .then(function(d){AD=d;if(cb)cb();})
        .catch(function(){PORT=null;tryPort(0);});
      return;
    }
    tryPort(tried);
  }

  // --- finding the composer -------------------------------------------------
  // Cursor renames its classes freely between versions, so match on structure
  // (an editable inside something composer-ish) rather than one exact class.
  var EDIT_SEL='textarea,[contenteditable="true"]';
  function composerInputs(){
    var out=[],nodes=document.querySelectorAll(EDIT_SEL);
    for(var i=0;i<nodes.length;i++){
      var n=nodes[i];
      if(n.closest('.composer-input-wrapper,.composer-input-container,[class*="composer"]'))out.push(n);
    }
    return out;
  }
  function inputBox(input){
    return input.closest('.composer-input-container')||
           input.closest('.full-input-box')||
           input.closest('.composer-input-wrapper')||
           input.parentElement;
  }

  // --- is the agent generating? --------------------------------------------
  // The Stop control is the most stable signal Cursor gives: it exists only
  // while a turn is in flight. Its label varies ("Stop", "Stop generation",
  // "Stop ^C"), so match the prefix.
  function generating(scope){
    if(!scope)return false;
    var els=scope.querySelectorAll('button,[role="button"],[aria-label]');
    for(var i=0;i<els.length;i++){
      var t=((els[i].getAttribute('aria-label')||els[i].textContent)||'').trim();
      if(/^stop\\b/i.test(t))return true;
    }
    return false;
  }

  // --- the card -------------------------------------------------------------
  function build(){
    var wrap=document.createElement('div');
    wrap.className='prmpt-chat-ad';
    wrap.style.cssText='width:100%;flex:0 0 100%;box-sizing:border-box;padding:0 0 6px 0;';
    var card=document.createElement('div');
    card.setAttribute('data-prmpt-card','1');
    card.style.cssText='border:1px solid rgba(127,127,127,.28);border-radius:6px;padding:8px 10px;'+
      'font-size:11px;line-height:1.4;cursor:pointer;opacity:.85;';
    var label=document.createElement('div');
    label.textContent='SPONSORED';
    label.style.cssText='font-size:9px;letter-spacing:.09em;opacity:.55;margin-bottom:3px;';
    var head=document.createElement('div');
    head.style.cssText='font-weight:600;';
    var body=document.createElement('div');
    body.style.cssText='opacity:.75;margin-top:2px;';
    card.appendChild(label);card.appendChild(head);card.appendChild(body);
    wrap.appendChild(card);
    card.addEventListener('click',function(){
      // Ask the extension host to open it. The renderer never opens a URL
      // itself: window.open inside Electron is unreliable and would bypass
      // vscode.env.openExternal, which is what the other surfaces use.
      if(PORT!==null)fetch('http://127.0.0.1:'+PORT+'/open',{cache:'no-store'}).catch(function(){});
    });
    wrap.__head=head;wrap.__body=body;
    return wrap;
  }

  function fill(node){
    if(!AD)return;
    // textContent, never innerHTML: this copy is model-generated.
    node.__head.textContent=AD.headline||'';
    node.__body.textContent=AD.body||'';
  }

  function place(node,input){
    var box=inputBox(input);
    if(!box||!box.parentElement)return;
    var par=box.parentElement;
    var dups=par.querySelectorAll('.prmpt-chat-ad');
    for(var i=0;i<dups.length;i++){
      if(dups[i]!==node&&dups[i].parentElement===par)dups[i].parentElement.removeChild(dups[i]);
    }
    if(node.parentElement!==par||node.nextElementSibling!==box)par.insertBefore(node,box);
  }

  function tick(){
    try{
      var inputs=composerInputs();
      for(var i=0;i<inputs.length;i++){
        var input=inputs[i];
        var scope=input.closest('[class*="composer"]')||input.parentElement;
        var node=input.__prmptNode;
        if(!node){node=build();input.__prmptNode=node;}
        if(!AD||!generating(scope)){if(node.isConnected)node.style.display='none';continue;}
        fill(node);place(node,input);node.style.display='block';
      }
    }catch(e){}
  }

  function boot(){
    fetchSlot();
    setInterval(function(){fetchSlot();},15000);
    setInterval(tick,400);
    tick();
  }
  function wait(){if(document.body)boot();else setTimeout(wait,100);}
  wait();
}catch(e){}
})();`}var ce=1,F=`/*__PRMPT_PATCH_V${ce}__*/`,b=/\/\*__PRMPT_PATCH_V\d+__\*\//,E=".prmpt-backup",w="out/vs/code/electron-sandbox/workbench/workbench.js",de=["out/vs/workbench/workbench.desktop.main.js","out/vs/workbench/workbench.glass.main.js"],R='performance.mark("code/didLoadWorkbenchMain"),B.main(S)})();',pe='performance.mark("code/didLoadWorkbenchMain"),B.main(S),setTimeout(function(){typeof PRMPT_RUN==="function"&&PRMPT_RUN()},2500)})();';function h(n){return B.join(P.env.appRoot,n)}function T(){return(P.env.appName||"").toLowerCase().includes("cursor")?!0:(P.env.appRoot||"").toLowerCase().includes("cursor")}function j(){try{return T()&&i.existsSync(h(w))}catch{return!1}}function O(){try{return b.test(i.readFileSync(h(w),"utf8"))}catch{return!1}}function U(){try{let n=i.readFileSync(h(w),"utf8");return b.test(n)&&!n.includes(F)}catch{return!1}}function W(n){let e=n,t=e.search(b);return t>=0&&(e=`${e.slice(0,t).trimEnd()}
`),e=e.replace(/performance\.mark\("code\/didLoadWorkbenchMain"\),B\.main\(S\),[^}]+\}\)\(\);/,R),e}function H(){for(let n of de){let e=h(n),t=e+E;try{if(i.existsSync(t)){i.copyFileSync(t,e),i.rmSync(t,{force:!0});continue}if(!i.existsSync(e))continue;let o=i.readFileSync(e,"utf8"),r=o.search(b);r>=0&&i.writeFileSync(e,`${o.slice(0,r).trimEnd()}
`)}catch{}}}function y(n){let e=h(w);if(!i.existsSync(e))return{ok:!1,message:"Cursor workbench.js not found \u2014 unsupported build."};try{H();let t=e+E;i.existsSync(t)||i.copyFileSync(e,t);let o=W(i.readFileSync(t,"utf8"));if(!o.includes(R))return{ok:!1,message:"Cursor\u2019s startup code has changed and the patch no longer fits. The sidebar and status bar still work; the chat card does not."};let r=L(n);try{new Function(r)}catch{return{ok:!1,message:"Generated patch failed validation \u2014 Cursor untouched."}}let c=`${o.replace(R,pe)}
${F}
function PRMPT_RUN(){${r}}
`;return i.writeFileSync(e,c),{ok:!0,message:"Chat card enabled. Reload Cursor to see it."}}catch(t){return{ok:!1,message:`Could not write to the Cursor install (${t instanceof Error?t.message:String(t)}). Nothing was changed.`}}}function q(){let n=h(w),e=n+E;try{if(H(),i.existsSync(e))return i.copyFileSync(e,n),i.rmSync(e,{force:!0}),{ok:!0,message:"Chat card removed. Reload Cursor."};if(!i.existsSync(n))return{ok:!0,message:"Nothing to remove."};let t=i.readFileSync(n,"utf8");return b.test(t)?(i.writeFileSync(n,W(t)),{ok:!0,message:"Chat card removed. Reload Cursor."}):{ok:!0,message:"Nothing to remove."}}catch(t){return{ok:!1,message:`Could not restore the Cursor install (${t instanceof Error?t.message:String(t)}).`}}}var V="prmpt.chatCardDeclined";async function le(n){let e=a=>{s.env.openExternal(s.Uri.parse(a.clickUrl))},t=new v(e),o=new k,r=new C(()=>{let a=p();a&&e(a)}),c=()=>s.workspace.getConfiguration("prmpt"),d=c().get("bridgePort",g);await r.start(d);let u=()=>{t.render(),o.render()};n.subscriptions.push(s.window.registerWebviewViewProvider(v.viewType,t,{webviewOptions:{retainContextWhenHidden:!0}}),o,{dispose:I(u)},{dispose:()=>r.dispose()},s.workspace.onDidChangeConfiguration(a=>{a.affectsConfiguration("prmpt")&&u()})),n.subscriptions.push(s.commands.registerCommand("prmpt.openCurrentAd",()=>{let a=p();a?e(a):s.window.showInformationMessage("prmpt: no sponsored line is parked right now.")}),s.commands.registerCommand("prmpt.applyCursorPatch",async()=>{let a=y(c().get("bridgePort",g));await(a.ok?s.window.showInformationMessage(`prmpt: ${a.message}`):s.window.showWarningMessage(`prmpt: ${a.message}`))}),s.commands.registerCommand("prmpt.removeCursorPatch",async()=>{let a=q();await(a.ok?s.window.showInformationMessage(`prmpt: ${a.message}`):s.window.showWarningMessage(`prmpt: ${a.message}`))}),s.commands.registerCommand("prmpt.showStatus",()=>fe())),u(),ue(n)}async function ue(n){if(!j())return;let e=s.workspace.getConfiguration("prmpt").get("cursorChatCard","ask");if(e==="off")return;let t=s.workspace.getConfiguration("prmpt").get("bridgePort",g);if(U()){y(t);return}if(O())return;if(e==="on"){y(t);return}if(n.globalState.get(V))return;let o="Enable";if(await s.window.showInformationMessage("prmpt can show the sponsored line above Cursor\u2019s chat input while the agent is working. Cursor has no extension point for that, so this modifies one file inside your Cursor installation (workbench.js). A backup is kept and \u201Cprmpt: Remove Cursor Chat Card\u201D restores it. The sidebar and status bar work either way.",o,"Not now")!==o){await n.globalState.update(V,!0);return}let d=y(t);await(d.ok?s.window.showInformationMessage(`prmpt: ${d.message}`):s.window.showWarningMessage(`prmpt: ${d.message}`))}function fe(){let n=p(),e=[`host: ${s.env.appName}${T()?" (chat card supported)":""}`,`parked ad: ${n?n.headline:"(none)"}`];T()&&e.push(`chat card: ${O()?"enabled":"not enabled"}`),s.window.showInformationMessage(`prmpt \u2014 ${e.join(" \xB7 ")}`)}function me(){}0&&(module.exports={activate,deactivate});
