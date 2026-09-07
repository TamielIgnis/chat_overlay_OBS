(function(){
    // ====== НАСТРОЙКИ ======
    const CHANNEL = "Название сюда";
    const MAX_MESSAGES = 25;
    const MSG_LIFETIME_MS = 10000; // 10 секунд - время жизни сообщения
    const WS_URL = "wss://irc-ws.chat.twitch.tv:443";
    const RECONNECT_DELAY_MS = 2500;
    // ========================

    const chatEl = document.getElementById('chat');
    let ws = null;
    let reconnectTimer = null;

    function escapeHtml(s){ return (s||'').toString().replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }
    function nameColor(name){ let h=0; for(let i=0;i<name.length;i++) h = name.charCodeAt(i) + ((h<<5)-h); return `hsl(${Math.abs(h)%360} 70% 55%)`; }
    function decodeTagValue(v){ return v.replace(/\\s/g,' ').replace(/\\:/g,';').replace(/\\\\/g,'\\').replace(/\\r/g,'\\r').replace(/\\n/g,'\\n'); }

    function parseIrcLine(line){
      let tags = {}; let prefix = null; let command = null; let params = [];
      let rest = line;
      if(rest.startsWith('@')){
        const idx = rest.indexOf(' ');
        const tagsStr = rest.slice(1, idx);
        rest = rest.slice(idx+1);
        tagsStr.split(';').forEach(p=>{
          if(!p) return;
          const [k,rawv] = p.split('=');
          tags[k] = rawv === undefined ? true : decodeTagValue(rawv);
        });
      }
      if(rest.startsWith(':')){
        const idx = rest.indexOf(' ');
        prefix = rest.slice(1, idx);
        rest = rest.slice(idx+1);
      }
      const trailingIdx = rest.indexOf(' :');
      if(trailingIdx !== -1){
        const head = rest.slice(0, trailingIdx);
        const tail = rest.slice(trailingIdx+2);
        const headParts = head.split(' ').filter(Boolean);
        command = headParts.shift();
        params = headParts.concat([tail]);
      } else {
        const parts = rest.split(' ').filter(Boolean);
        command = parts.shift();
        params = parts;
      }
      return { tags, prefix, command, params };
    }

    function parseEmotesTag(emotesStr){
      if(!emotesStr) return null;
      const out = {};
      emotesStr.split('/').forEach(g=>{
        const [id, ranges] = g.split(':');
        if(!id||!ranges) return;
        out[id] = ranges.split(',').map(r=>r.trim()).filter(Boolean);
      });
      return out;
    }

    function renderEmotes(message, emotesTag){
      if(!emotesTag) return escapeHtml(message);
      const emotes = parseEmotesTag(emotesTag);
      if(!emotes || Object.keys(emotes).length===0) return escapeHtml(message);
      const parts = [];
      Object.entries(emotes).forEach(([id, ranges])=>{
        ranges.forEach(r=>{
          const [s,e] = r.split('-').map(n=>parseInt(n,10));
          parts.push({start:s,end:e,id});
        });
      });
      parts.sort((a,b)=>a.start-b.start);
      let out="", idx=0;
      for(const p of parts){
        if(p.start>idx) out+=escapeHtml(message.slice(idx,p.start));
        const code = message.slice(p.start,p.end+1);
        const url = `https://static-cdn.jtvnw.net/emoticons/v2/${p.id}/default/dark/3.0`;
        out += `<img class="emote" alt="${escapeHtml(code)}" src="${url}" />`;
        idx = p.end+1;
      }
      if(idx<message.length) out+=escapeHtml(message.slice(idx));
      return out;
    }

    function removeMessageElement(el){
      if(!el) return;
      if(el._autoHideTimer){ clearTimeout(el._autoHideTimer); el._autoHideTimer = null; }
      el.classList.add('fade-out');
      setTimeout(()=> {
        el.remove();
        chatEl.scrollTop = 0;
      }, 220);
    }

    function pushMessage({displayName, username, message, tags}){
      const wrapper = document.createElement('div');
      wrapper.className = 'msg';
      if(tags && tags.mod === '1') wrapper.classList.add('mod');
      if(tags && tags.badges && String(tags.badges).includes('broadcaster')) wrapper.classList.add('broadcaster');

      const unameColor = (tags && tags.color) ? tags.color : nameColor(username || displayName || 'anon');
      const messageHtml = renderEmotes(message, tags && tags.emotes);

      wrapper.innerHTML = `
        <div class="text-wrap">
          <div class="meta">
            <span class="user" style="color:${unameColor}">${escapeHtml(displayName || username || '')}</span>
            <span style="opacity:0.8; font-size:0.95em;">:</span>
          </div>
          <div class="message">${messageHtml}</div>
        </div>
      `;

      chatEl.insertBefore(wrapper, chatEl.firstChild);

      wrapper._autoHideTimer = setTimeout(()=> removeMessageElement(wrapper), MSG_LIFETIME_MS);

      while(chatEl.children.length > MAX_MESSAGES){
        const last = chatEl.lastElementChild;
        if(last) removeMessageElement(last);
        else break;
      }

      chatEl.scrollTop = 0;
    }

    function handleIrcLine(line){
      if(!line) return;
      if(line.startsWith('PING')){ try{ ws && ws.send('PONG :tmi.twitch.tv'); }catch(e){}; return; }
      const parsed = parseIrcLine(line);
      if(parsed.command === 'PRIVMSG'){
        const text = parsed.params[1] || '';
        const tags = parsed.tags || {};
        pushMessage({
          displayName: tags['display-name'] || (parsed.prefix ? parsed.prefix.split('!')[0] : ''),
          username: parsed.prefix ? parsed.prefix.split('!')[0] : '',
          message: text,
          tags: tags
        });
      }
    }

    function connect(){
      if(ws) try{ ws.close(); }catch(e){}
      ws = new WebSocket(WS_URL);
      ws.addEventListener('open', ()=>{
        ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership');
        const anonNick = 'justinfan' + Math.floor(Math.random()*1000000);
        ws.send(`NICK ${anonNick}`);
        ws.send(`JOIN #${CHANNEL.toLowerCase()}`);
      });

      let buffer = '';
      ws.addEventListener('message', (ev)=>{
        buffer += ev.data;
        const lines = buffer.split('\r\n');
        buffer = lines.pop();
        lines.forEach(l => { if(l) handleIrcLine(l); });
      });

      ws.addEventListener('close', ()=> scheduleReconnect() );
      ws.addEventListener('error', (e)=> console.warn('WS error', e) );
    }

    function scheduleReconnect(){
      if(reconnectTimer) return;
      reconnectTimer = setTimeout(()=>{ reconnectTimer = null; connect(); }, RECONNECT_DELAY_MS);
    }

    connect();
    window.addEventListener('beforeunload', ()=> { try{ ws && ws.close(); }catch(e){} });

  })();