// OMAMA Produção v2 – servidor (Cloudflare Worker + D1 "DB"), no modelo do Sensio.
// Segredo: CODIGO (código de acesso do líder/admin).

const ORIGENS = ['https://expedicao-star.github.io'];
const cors = (req) => {
  const o = req.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': ORIGENS.includes(o) || o.startsWith('http://localhost') ? o : ORIGENS[0],
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Codigo,X-Token',
    'Vary': 'Origin',
  };
};
const json = (req, data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(req) } });
const agora = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const minDesde = (s) => Math.max(0, (Date.now() - Date.parse(s.replace(' ', 'T') + 'Z')) / 60000);
// ---------- sincronização com a v.8 (Google Sheets manda os dados por um Apps Script)
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
const dataBR = s => { const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null; };
const ORDEM_ST = { 'em producao': 1, 'pronto / embalagem': 2, 'transportadora': 3, 'entregue': 4, 'cancelada': 5, 'cancelado': 5 };
const SAIU = ['enviada', 'entregue', 'cancelado', 'cancelada'];
const tokensOk = (nome, prod, mad) => { const n = norm(nome), M = norm(mad), P = norm(prod).split(' ').filter(Boolean);
  return !!M && n.endsWith(' ' + M) && P.every(t => (' ' + n.slice(0, -M.length) + ' ').includes(' ' + t + ' ')); };
async function syncV8(DB, body) {
  const simular = !!body.simular;
  const prods = await all(DB, "select id, nome from item where tipo='Produto'");
  const acha = (prod, mad) => { const c = prods.filter(i => tokensOk(i.nome, prod, mad)); c.sort((a, b) => a.nome.split(' ').length - b.nome.split(' ').length); return c[0] || null; };
  const r = { pedidos_novos: [], pedidos_atualizados: [], pecas_novas: [], sem_cadastro: [] };
  // peças pendentes (não enviadas) por pedido + produto + madeira
  const grupos = new Map();
  for (const pc of body.pecas || []) {
    const num = String(pc.pedido || '').trim(); if (!num || !pc.produto) continue;
    if (SAIU.includes(norm(pc.etapa))) continue;
    const k = num + '|' + norm(pc.produto) + '|' + norm(pc.madeira);
    const g = grupos.get(k) || { num, produto: String(pc.produto).trim(), madeira: String(pc.madeira || '').trim(), pend: 0, etapas: {} };
    const q = Number(String(pc.qtd || '1').replace(',', '.')) || 1;
    g.pend += q; g.etapas[pc.etapa || ''] = (g.etapas[pc.etapa || ''] || 0) + q; grupos.set(k, g);
  }
  const pendPorPedido = {}; for (const g of grupos.values()) pendPorPedido[g.num] = (pendPorPedido[g.num] || 0) + g.pend;
  // pedidos
  const existentes = new Map((await all(DB, 'select * from pedido')).map(x => [String(x.numero), x]));
  const st = [];
  for (const pv of body.pedidos || []) {
    const num = String(pv.numero || '').trim(); if (!/^\d+$/.test(num)) continue;
    const stt = String(pv.status || '').trim(), ex = existentes.get(num);
    const cliente = String(pv.cliente || '').trim() || null, prazo = dataBR(pv.prazo), pag = dataBR(pv.data_pagamento);
    if (!ex) {
      if (!pendPorPedido[num] || (ORDEM_ST[norm(stt)] || 1) >= 4) continue;
      st.push(DB.prepare('insert into pedido(numero, cliente, prazo, data_pagamento, status, obs) values(?,?,?,?,?,?)').bind(num, cliente, prazo, pag, stt || 'Em produção', pv.tipo ? 'Tipo: ' + pv.tipo : null));
      r.pedidos_novos.push(num + ' · ' + (cliente || ''));
    } else {
      const novoSt = (ORDEM_ST[norm(stt)] || 0) > (ORDEM_ST[norm(ex.status)] || 0) ? stt : ex.status;
      if (ex.cliente !== cliente || ex.prazo !== prazo || ex.data_pagamento !== pag || novoSt !== ex.status) {
        st.push(DB.prepare('update pedido set cliente=?, prazo=?, data_pagamento=?, status=? where id=?').bind(cliente, prazo, pag, novoSt, ex.id));
        r.pedidos_atualizados.push(num + (novoSt !== ex.status ? ' → ' + novoSt : ''));
      }
    }
  }
  if (st.length && !simular) await DB.batch(st);
  // peças novas (só aumenta: o que a v.8 tem pendente além do que já está aqui)
  const abertos = new Map((await all(DB, "select id, numero from pedido where status not in ('Entregue','Cancelado','Cancelada')")).map(x => [String(x.numero), x.id]));
  const pis = await all(DB, 'select pedido_id, item_id, descricao, qtd from pedido_item');
  const st2 = [];
  for (const g of grupos.values()) {
    const pid = abertos.get(g.num); if (!pid && !(simular && r.pedidos_novos.some(x => x.startsWith(g.num + ' ')))) continue;
    const it = acha(g.produto, g.madeira);
    const desc = it ? it.nome : `${g.produto} ${g.madeira}`.trim();
    const aqui = pis.filter(x => x.pedido_id === pid && (it ? x.item_id === it.id : !x.item_id && tokensOk(x.descricao, g.produto, g.madeira))).reduce((s, x) => s + x.qtd, 0);
    const novo = g.pend - aqui; if (novo <= 0) continue;
    const etapa = Object.entries(g.etapas).sort((a, b) => b[1] - a[1])[0][0] || null;
    const conf = ['controle de qualidade', 'prontas'].includes(norm(etapa)) ? novo : 0;
    if (!simular) st2.push(DB.prepare('insert into pedido_item(pedido_id, item_id, descricao, qtd, etapa_v8, conferida) values(?,?,?,?,?,?)').bind(pid, it ? it.id : null, desc, novo, etapa, conf));
    r.pecas_novas.push(`${g.num}: ${novo} × ${desc}`);
    if (!it) r.sem_cadastro.push(`${g.num}: ${desc}`);
  }
  if (!simular) {
    st2.push(DB.prepare('insert into sync_log(origem, resumo) values(?,?)').bind('v8', JSON.stringify(r)));
    await DB.batch(st2);
  }
  return r;
}

const RT_BASE = 100000, ESTAGIO_RT = 13;
const ESTAGIO_INICIAL = 1, ESTAGIO_FINAL = 12, DEP_PA = 1, DEP_PA_SP = 3, DEP_PATIO = 11, DEP_DEFEITO = 6, DEP_INSUMOS = 2;

const all = async (DB, sql, ...b) => (await DB.prepare(sql).bind(...b).all()).results;
const one = async (DB, sql, ...b) => await DB.prepare(sql).bind(...b).first();
const evento = (DB, op_id, texto) => DB.prepare('insert into op_evento(op_id, texto) values(?,?)').bind(op_id, texto);

async function recalcularOp(DB, op_id) {
  const op = await one(DB, 'select * from op where id=?', op_id);
  if (!op || op.status !== 'aberta') return;
  const prox = await one(DB, `select t.estagio_id from op_operacao oo join operacao_tipo t on t.id=oo.operacao_tipo_id
    where oo.op_id=? and oo.status<>'finalizado' order by oo.ordem limit 1`, op_id);
  if (prox) {
    if (prox.estagio_id !== op.estagio_id) {
      const e = await one(DB, 'select nome from estagio where id=?', prox.estagio_id);
      await DB.batch([DB.prepare('update op set estagio_id=? where id=?').bind(prox.estagio_id, op_id), evento(DB, op_id, 'Estágio: ' + e.nome)]);
    }
    return;
  }
  if (op.tipo === 'RT') {
    const nome = 'RT ' + (op.codigo - RT_BASE);
    const st = [DB.prepare("update op set status='finalizada', estagio_id=?, finalizado_em=? where id=?").bind(ESTAGIO_FINAL, agora(), op_id)];
    const d = op.defeito_id ? await one(DB, 'select * from defeito where id=?', op.defeito_id) : null;
    if (d && d.situacao === 'retrabalho') {
      st.push(DB.prepare("update defeito set situacao='recuperado', resolvido_em=?, resolucao_obs=? where id=?").bind(agora(), 'Recuperada pelo ' + nome, d.id),
        DB.prepare('insert into estoque_mov(item_id, deposito_id, qtd, motivo, op_id) values(?,?,?,?,?)').bind(d.item_id, DEP_DEFEITO, -d.qtd, 'Recuperada pelo ' + nome, op_id),
        DB.prepare('insert into estoque_mov(item_id, deposito_id, qtd, motivo, op_id) values(?,?,?,?,?)').bind(d.item_id, DEP_PA, d.qtd, 'Recuperada pelo ' + nome, op_id),
        evento(DB, op_id, nome + ' finalizado: peça saiu do Defeito e entrou no P.A. Manaus'));
    } else st.push(evento(DB, op_id, nome + ' finalizado'));
    await DB.batch(st);
    return;
  }
  // todas as operações finalizadas: finaliza a OP e dá entrada no P.A. (os blocos já saíram na criação da OP)
  const st = [
    DB.prepare("update op set status='finalizada', estagio_id=?, finalizado_em=? where id=?").bind(ESTAGIO_FINAL, agora(), op_id),
    DB.prepare('insert into estoque_mov(item_id, deposito_id, qtd, motivo, op_id) values(?,?,?,?,?)').bind(op.item_id, DEP_PA, op.qtd, 'Entrada da OP ' + op.codigo, op_id),
    evento(DB, op_id, 'OP finalizada: entrada no P.A.'),
  ];
  await DB.batch(st);
}

async function opsAbertas(DB, where = "op.status='aberta'", ...b) {
  return all(DB, `select op.id, op.codigo, op.qtd, op.estagio_id, op.previsao_inicio, op.previsao_fim, op.pedido, op.status, op.origem, op.tipo, op.motivo, op.defeito_id,
      i.id item_id, i.codigo item_codigo, i.nome item_nome, op.pedido_item_id, pd.numero pedido_numero, pd.cliente pedido_cliente,
      (select t.nome || '|' || oo.status || '|' || coalesce(f.nome,'') from op_operacao oo join operacao_tipo t on t.id=oo.operacao_tipo_id
         left join funcionario f on f.id=oo.funcionario_id where oo.op_id=op.id and oo.status<>'finalizado' order by oo.ordem limit 1) atual
    from op join item i on i.id=op.item_id left join pedido_item pi on pi.id=op.pedido_item_id left join pedido pd on pd.id=pi.pedido_id where ${where} order by op.previsao_fim is null, op.previsao_fim, op.codigo`, ...b);
}

// ---------- usuários: login e senha (senha guardada só como hash PBKDF2), sessão por token
const MAX_USUARIOS = 5; // além do administrador
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
async function hashSenha(senha, salt) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(senha), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100000 }, k, 256));
}
const loginOk = l => /^[a-z0-9._-]{3,30}$/.test(l);
// permissões: quais telas o usuário usa. Leitura é livre (as telas compartilham dados); gravar e ver dados de pessoas pede a tela.
const TELAS = ['painel', 'fila', 'ops', 'ped', 'exp', 'pcp', 'estoque', 'ent', 'inv', 'defeitos', 'itens', 'func', 'assid', 'rel', 'efic', 'qual', 'sem'];
const PERM = [
  [/^\/api\/presenca/, null, ['assid', 'sem']], [/^\/api\/relatorio/, null, ['rel', 'sem']], [/^\/api\/eficiencia/, null, ['efic', 'rel', 'painel']], [/^\/api\/metas/, 'POST', ['efic']], [/^\/api\/semana/, null, ['sem']], [/^\/api\/painel/, null, ['painel']],
  [/^\/api\/operacoes\//, 'POST', ['fila', 'ops']], [/^\/api\/ops/, 'POST', ['ops', 'ped', 'pcp']],
  [/^\/api\/pedidos\/[^/]+\/envio/, 'POST', ['exp']], [/^\/api\/pedido-itens\/\d+\/exp/, 'POST', ['exp']], [/^\/api\/pedidos/, 'POST', ['ped']],
  [/^\/api\/pcp/, 'POST', ['pcp']], [/^\/api\/estoque\/mov/, 'POST', ['estoque']], [/^\/api\/entradas/, 'POST', ['ent']], [/^\/api\/inventarios/, 'POST', ['inv']],
  [/^\/api\/defeitos/, 'POST', ['defeitos', 'ops']], [/^\/api\/rt/, 'POST', ['ops', 'defeitos']], [/^\/api\/qualidade/, 'POST', ['qual']], [/^\/api\/itens/, 'POST', ['itens']], [/^\/api\/funcionarios/, 'POST', ['func']], [/^\/api\/fotos/, 'POST', ['ops', 'defeitos', 'qual', 'ped']],
  [/^\/api\/sync\//, 'POST', ['admin']],
];
const lePerm = s => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a.filter(t => TELAS.includes(t)) : []; } catch (e) { return []; } };
async function novaSessao(DB, u) {
  const tok = crypto.randomUUID() + crypto.randomUUID();
  await DB.prepare("insert into sessao(token_hash, usuario_id, expira_em) values(?,?,datetime('now','+30 days'))").bind(await sha256(tok), u.id).run();
  return { token: tok, usuario: { id: u.id, login: u.login, nome: u.nome, admin: u.admin } };
}
const usuarioDoToken = async (DB, tok) => one(DB, `select u.id, u.login, u.nome, u.admin, u.permissoes from sessao s join usuario u on u.id=s.usuario_id
  where s.token_hash=? and s.expira_em > datetime('now') and u.ativo=1`, await sha256(tok));
async function rotasAbertas(req, env, p) {
  const DB = env.DB;
  if (p === '/api/auth/estado') return json(req, { tem_usuarios: !!(await one(DB, 'select id from usuario limit 1')) });
  const b = await req.json().catch(() => ({}));
  if (p === '/api/auth/primeiro') {
    if (await one(DB, 'select id from usuario limit 1')) return json(req, { erro: 'O administrador já foi criado' }, 400);
    if (String(b.codigo || '') !== env.CODIGO) return json(req, { erro: 'Código do sistema errado' }, 400);
    const login = String(b.login || '').trim().toLowerCase();
    if (!loginOk(login)) return json(req, { erro: 'Usuário: de 3 a 30 letras minúsculas, números, ponto ou traço (sem espaço)' }, 400);
    if (String(b.senha || '').length < 6) return json(req, { erro: 'A senha precisa de pelo menos 6 caracteres' }, 400);
    const salt = crypto.randomUUID();
    await DB.prepare('insert into usuario(login, nome, senha_hash, salt, admin) values(?,?,?,?,1)').bind(login, String(b.nome || '').trim() || login, await hashSenha(String(b.senha), salt), salt).run();
    return json(req, await novaSessao(DB, await one(DB, 'select * from usuario where login=?', login)));
  }
  // /api/auth/login
  const u = await one(DB, 'select * from usuario where login=? and ativo=1', String(b.login || '').trim().toLowerCase());
  if (!u || await hashSenha(String(b.senha || ''), u.salt) !== u.senha_hash) {
    await new Promise(r => setTimeout(r, 800));
    return json(req, { erro: 'Usuário ou senha errados' }, 400);
  }
  return json(req, await novaSessao(DB, u));
}

// ---------- conector do Claude (MCP, HTTP simples) — endereço /mcp/<CODIGO>
const FERRAMENTAS = [
  { name: 'resumo_fabrica', description: 'Resumo ao vivo da fábrica OMAMA: OPs abertas e atrasadas, peças por estágio, produção de hoje e da semana, pedidos vencendo em 7 dias, defeitos e faltas.', inputSchema: { type: 'object', properties: {} }, path: () => '/api/painel' },
  { name: 'pedidos_abertos', description: 'Lista os pedidos em aberto com prazo, status e quantas peças têm OP, estão conferidas, embaladas e enviadas.', inputSchema: { type: 'object', properties: {} }, path: () => '/api/pedidos' },
  { name: 'pedido', description: 'Detalhe de um pedido OMAMA pelo número: peças, OPs ligadas (estágio), conferidas/embaladas/enviadas e envios.', inputSchema: { type: 'object', properties: { numero: { type: 'string' } }, required: ['numero'] }, path: a => '/api/pedidos/' + encodeURIComponent(a.numero) },
  { name: 'ops_abertas', description: 'Lista as OPs abertas com item, quantidade, estágio, previsão de entrega, pedido e operação atual.', inputSchema: { type: 'object', properties: {} }, path: () => '/api/ops' },
  { name: 'estoque', description: 'Saldo de estoque de um depósito. deposito_id: 1 = P.A. Manaus (produto acabado na fábrica), 3 = P.A. São Paulo, 11 = Pátio (blocos de madeira), 6 = Defeito, 2 = Insumos.', inputSchema: { type: 'object', properties: { deposito_id: { type: 'number' } }, required: ['deposito_id'] }, path: a => '/api/estoque?deposito_id=' + Number(a.deposito_id) },
  { name: 'producao_periodo', description: 'Produção e eficiência por pessoa num período (datas AAAA-MM-DD).', inputSchema: { type: 'object', properties: { de: { type: 'string' }, ate: { type: 'string' } }, required: ['de', 'ate'] }, path: a => `/api/relatorio?de=${a.de}&ate=${a.ate}` },
  { name: 'defeitos', description: 'Peças que estão no estoque de defeito agora (item, quantidade, motivo, OP, setor).', inputSchema: { type: 'object', properties: {} }, path: () => '/api/defeitos' },
  { name: 'faltas_semana', description: 'Faltas, atestados, atrasos e folgas lançados num período (datas AAAA-MM-DD).', inputSchema: { type: 'object', properties: { de: { type: 'string' }, ate: { type: 'string' } }, required: ['de', 'ate'] }, path: a => `/api/presenca?de=${a.de}&ate=${a.ate}` },
  { name: 'pcp_sugestao', description: 'Sugestão do PCP: peças de pedidos que ainda precisam de OP, quantas dá para fazer com o bloco do Pátio e quanta madeira falta.', inputSchema: { type: 'object', properties: {} }, path: () => '/api/pcp/sugestao' },
];
async function mcp(req, env) {
  if (req.method !== 'POST') return new Response('Use POST (MCP)', { status: 405 });
  const msg = await req.json().catch(() => null);
  const responde = (id, result) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: { 'Content-Type': 'application/json' } });
  const erro = (id, code, message) => new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), { headers: { 'Content-Type': 'application/json' } });
  if (!msg || Array.isArray(msg)) return erro(null, -32600, 'Requisição inválida');
  if (msg.id === undefined) return new Response(null, { status: 202 });
  if (msg.method === 'initialize') return responde(msg.id, { protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'omama-producao', version: '1.0' },
    instructions: 'Dados ao vivo do sistema de produção da OMAMA (OPs, pedidos, estoque, expedição, defeitos, assiduidade). Somente leitura.' });
  if (msg.method === 'ping') return responde(msg.id, {});
  if (msg.method === 'tools/list') return responde(msg.id, { tools: FERRAMENTAS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  if (msg.method === 'tools/call') {
    const f = FERRAMENTAS.find(x => x.name === (msg.params || {}).name);
    if (!f) return erro(msg.id, -32602, 'Ferramenta não existe');
    const r = await app.fetch(new Request('https://interno' + f.path((msg.params || {}).arguments || {}), { headers: { 'X-Codigo': env.CODIGO } }), env);
    return responde(msg.id, { content: [{ type: 'text', text: await r.text() }], isError: !r.ok });
  }
  return erro(msg.id, -32601, 'Método não suportado');
}

const app = {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(req) });
    const url = new URL(req.url), p = url.pathname, q = (k) => url.searchParams.get(k);
    if (p === '/') return json(req, { ok: true, sistema: 'OMAMA Produção', versao: 2 });
    if (p.startsWith('/.well-known/')) return new Response('não existe', { status: 404 });
    if (p.startsWith('/mcp/')) return p === '/mcp/' + env.CODIGO ? mcp(req, env) : new Response('não autorizado', { status: 401 });
    if (['/api/auth/estado', '/api/auth/primeiro', '/api/auth/login'].includes(p)) return rotasAbertas(req, env, p);
    // acesso: login do usuário (X-Token / ?t=) ou o código interno do sistema (v.8, conector do Claude)
    const cod = req.headers.get('X-Codigo') || q('c') || '', tok = req.headers.get('X-Token') || q('t') || '';
    const usuario = cod && cod === env.CODIGO ? { id: 0, login: null, nome: 'Sistema', admin: 1 } : tok ? await usuarioDoToken(env.DB, tok) : null;
    if (!usuario) return json(req, { erro: 'Faça login' }, 401);
    usuario.permissoes = usuario.admin ? TELAS : lePerm(usuario.permissoes);
    if (!usuario.admin) { const r = PERM.find(([re, met]) => re.test(p) && (!met || met === req.method));
      if (r && !r[2].some(t => usuario.permissoes.includes(t))) return json(req, { erro: 'Você não tem permissão para isso. Fale com o administrador.' }, 403); }
    const DB = env.DB;
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    let m;
    try {
      // ---------- usuários
      if (p === '/api/eu') return json(req, usuario);
      if (p === '/api/auth/sair' && req.method === 'POST') {
        const tok = req.headers.get('X-Token'); if (tok) await DB.prepare('delete from sessao where token_hash=?').bind(await sha256(tok)).run();
        return json(req, { ok: true });
      }
      if (p === '/api/auth/senha' && req.method === 'POST') {
        const u = await one(DB, 'select * from usuario where id=?', usuario.id);
        if (!u) return json(req, { erro: 'Entre com seu usuário para trocar a senha' }, 400);
        if (await hashSenha(String(body.atual || ''), u.salt) !== u.senha_hash) return json(req, { erro: 'Senha atual errada' }, 400);
        if (String(body.nova || '').length < 6) return json(req, { erro: 'A senha nova precisa de pelo menos 6 caracteres' }, 400);
        const salt = crypto.randomUUID();
        await DB.prepare('update usuario set senha_hash=?, salt=? where id=?').bind(await hashSenha(String(body.nova), salt), salt, u.id).run();
        return json(req, { ok: true });
      }
      if (p.startsWith('/api/usuarios') && !usuario.admin) return json(req, { erro: 'Só o administrador mexe em usuários' }, 403);
      if (p === '/api/usuarios' && req.method === 'GET') {
        return json(req, { max: MAX_USUARIOS, telas: TELAS, lista: (await all(DB, `select id, login, nome, admin, ativo, criado_em, permissoes,
          (select max(criado_em) from sessao where usuario_id=usuario.id) ultimo_acesso from usuario order by admin desc, ativo desc, nome`)).map(u => ({ ...u, permissoes: u.admin ? TELAS : lePerm(u.permissoes) })) });
      }
      if (p === '/api/usuarios' && req.method === 'POST') {
        const login = String(body.login || '').trim().toLowerCase();
        if (!loginOk(login)) return json(req, { erro: 'Usuário: de 3 a 30 letras minúsculas, números, ponto ou traço (sem espaço)' }, 400);
        if (String(body.senha || '').length < 6) return json(req, { erro: 'A senha precisa de pelo menos 6 caracteres' }, 400);
        if ((await one(DB, 'select count(*) n from usuario where admin=0 and ativo=1')).n >= MAX_USUARIOS) return json(req, { erro: `Já tem ${MAX_USUARIOS} usuários ativos (o máximo). Desative um antes.` }, 400);
        if (await one(DB, 'select id from usuario where login=?', login)) return json(req, { erro: 'Esse usuário já existe' }, 400);
        const salt = crypto.randomUUID();
        await DB.prepare('insert into usuario(login, nome, senha_hash, salt, admin, permissoes) values(?,?,?,?,0,?)').bind(login, String(body.nome || '').trim() || login, await hashSenha(String(body.senha), salt), salt, JSON.stringify(Array.isArray(body.permissoes) ? lePerm(JSON.stringify(body.permissoes)) : TELAS)).run();
        return json(req, { ok: true });
      }
      if ((m = p.match(/^\/api\/usuarios\/(\d+)$/)) && req.method === 'POST') {
        const u = await one(DB, 'select * from usuario where id=?', Number(m[1]));
        if (!u) return json(req, { erro: 'Usuário não encontrado' }, 404);
        const ativo = body.ativo === undefined ? u.ativo : (body.ativo ? 1 : 0);
        if (u.admin && !ativo) return json(req, { erro: 'Não dá para desativar o administrador' }, 400);
        if (ativo && !u.ativo && (await one(DB, 'select count(*) n from usuario where admin=0 and ativo=1')).n >= MAX_USUARIOS) return json(req, { erro: `Já tem ${MAX_USUARIOS} usuários ativos (o máximo)` }, 400);
        const st = [DB.prepare('update usuario set nome=?, ativo=?, permissoes=? where id=?').bind(body.nome === undefined ? u.nome : (String(body.nome).trim() || u.nome), ativo, Array.isArray(body.permissoes) ? JSON.stringify(lePerm(JSON.stringify(body.permissoes))) : u.permissoes, u.id)];
        if (body.senha) {
          if (String(body.senha).length < 6) return json(req, { erro: 'A senha precisa de pelo menos 6 caracteres' }, 400);
          const salt = crypto.randomUUID();
          st.push(DB.prepare('update usuario set senha_hash=?, salt=? where id=?').bind(await hashSenha(String(body.senha), salt), salt, u.id));
        }
        if (body.senha || !ativo) st.push(DB.prepare('delete from sessao where usuario_id=?').bind(u.id));
        await DB.batch(st);
        return json(req, { ok: true });
      }

      // ---------- base
      if (p === '/api/base') {
        const [estagios, tipos, setores, funcionarios, depositos] = await Promise.all([
          all(DB, 'select * from estagio order by ordem'), all(DB, 'select * from operacao_tipo order by id'),
          all(DB, 'select * from setor order by id'), all(DB, 'select * from funcionario where ativo=1 order by nome'),
          all(DB, 'select * from deposito order by id')]);
        return json(req, { estagios, tipos, setores, funcionarios, depositos });
      }
      if (p === '/api/funcionarios' && req.method === 'GET') {
        return json(req, await all(DB, 'select f.*, s.nome setor from funcionario f left join setor s on s.id=f.setor_id order by f.ativo desc, s.id, f.nome'));
      }
      if (p === '/api/funcionarios' && req.method === 'POST') {
        if (!body.nome) return json(req, { erro: 'Nome obrigatório' }, 400);
        await DB.prepare('insert into funcionario(nome, setor_id) values(?,?)').bind(body.nome.trim(), body.setor_id || null).run();
        return json(req, { ok: true });
      }
      if ((m = p.match(/^\/api\/funcionarios\/(\d+)$/)) && req.method === 'POST') {
        if (!body.nome) return json(req, { erro: 'Nome obrigatório' }, 400);
        await DB.prepare('update funcionario set nome=?, setor_id=?, ativo=? where id=?').bind(body.nome.trim(), body.setor_id || null, body.ativo ? 1 : 0, Number(m[1])).run();
        return json(req, { ok: true });
      }

      // ---------- assiduidade (sem registro = presente)
      if (p === '/api/presenca' && req.method === 'GET') {
        if (q('de')) return json(req, await all(DB, 'select pr.*, f.nome, s.nome setor from presenca pr join funcionario f on f.id=pr.funcionario_id left join setor s on s.id=f.setor_id where pr.data between ? and ? and pr.status is not null order by pr.data, f.nome', q('de'), q('ate')));
        return json(req, await all(DB, 'select * from presenca where data=?', q('data')));
      }
      if (p === '/api/presenca' && req.method === 'POST') {
        if (!body.data || !body.funcionario_id) return json(req, { erro: 'Data e pessoa' }, 400);
        if (!body.status || body.status === 'presente') await DB.prepare('delete from presenca where data=? and funcionario_id=?').bind(body.data, body.funcionario_id).run();
        else await DB.prepare(`insert into presenca(data, funcionario_id, falta, status, minutos, obs) values(?,?,?,?,?,?)
            on conflict(data, funcionario_id) do update set falta=excluded.falta, status=excluded.status, minutos=excluded.minutos, obs=excluded.obs`)
          .bind(body.data, body.funcionario_id, body.status.startsWith('falta') ? 1 : 0, body.status, body.minutos || null, body.obs || null).run();
        return json(req, { ok: true });
      }
      if (p === '/api/presenca/resumo') {
        return json(req, await all(DB, `select f.id, f.nome, s.nome setor,
            coalesce(sum(pr.status='falta_justificada'),0) falta_just, coalesce(sum(pr.status='falta_injustificada'),0) falta_injust,
            coalesce(sum(pr.status='atestado'),0) atestado, coalesce(sum(pr.status='atraso'),0) atrasos, coalesce(sum(case when pr.status='atraso' then pr.minutos end),0) min_atraso,
            coalesce(sum(pr.status='folga'),0) folgas
          from funcionario f left join setor s on s.id=f.setor_id left join presenca pr on pr.funcionario_id=f.id and pr.data between ? and ?
          where f.ativo=1 group by f.id order by s.id, f.nome`, q('de'), q('ate')));
      }

      // ---------- defeitos (depósito Defeito = 6, Retrabalho = 4)
      if (p === '/api/defeitos' && req.method === 'GET') {
        const sel = `select d.*, i.codigo, i.nome item, s.nome setor, f.nome funcionario, o.codigo op_codigo, (select x.codigo from op x where x.defeito_id=d.id and x.status='aberta') rt_codigo
          from defeito d join item i on i.id=d.item_id left join setor s on s.id=d.setor_id left join funcionario f on f.id=d.funcionario_id left join op o on o.id=d.op_id`;
        if (q('situacao') === 'todos') return json(req, await all(DB, sel + ' where d.data between ? and ? order by d.id desc limit 500', q('de'), q('ate') + ' 23:59:59'));
        return json(req, await all(DB, sel + " where d.situacao in ('em_defeito','retrabalho') order by d.id desc"));
      }
      if (p === '/api/defeitos/resumo') {
        const de = q('de'), ate = q('ate') + ' 23:59:59';
        const [porMotivo, porSetor, porSituacao] = await Promise.all([
          all(DB, 'select motivo, sum(qtd) qtd from defeito where data between ? and ? group by motivo order by qtd desc', de, ate),
          all(DB, "select coalesce(s.nome,'—') setor, sum(d.qtd) qtd from defeito d left join setor s on s.id=d.setor_id where d.data between ? and ? group by d.setor_id order by qtd desc", de, ate),
          all(DB, 'select situacao, sum(qtd) qtd from defeito where data between ? and ? group by situacao', de, ate)]);
        return json(req, { porMotivo, porSetor, porSituacao });
      }
      if (p === '/api/defeitos' && req.method === 'POST') {
        const it = await one(DB, 'select * from item where id=?', body.item_id);
        if (!it || !(body.qtd > 0) || !body.motivo) return json(req, { erro: 'Item, quantidade e motivo' }, 400);
        const op = body.op_codigo ? await one(DB, 'select * from op where codigo=?', Number(body.op_codigo)) : null;
        if (body.op_codigo && !op) return json(req, { erro: 'OP não encontrada' }, 400);
        const daPA = body.origem === 'pa';
        const r = await DB.prepare('insert into defeito(data, item_id, qtd, op_id, setor_id, motivo, funcionario_id, obs, origem) values(?,?,?,?,?,?,?,?,?)')
          .bind(agora(), it.id, body.qtd, op ? op.id : null, body.setor_id || null, body.motivo, body.funcionario_id || null, body.obs || null, daPA ? 'pa' : 'producao').run();
        const st = [DB.prepare('insert into estoque_mov(item_id, deposito_id, qtd, motivo, op_id) values(?,?,?,?,?)').bind(it.id, DEP_DEFEITO, body.qtd, 'Defeito: ' + body.motivo, op ? op.id : null)];
        if (daPA) st.push(DB.prepare('insert into estoque_mov(item_id, deposito_id, qtd, motivo) values(?,?,?,?)').bind(it.id, DEP_PA, -body.qtd, 'Saiu do P.A. por defeito: ' + body.motivo));
        if (op) st.push(evento(DB, op.id, `Defeito registrado: ${body.qtd} × ${it.nome} (${body.motivo})`));
        await DB.batch(st);
        return json(req, { ok: true, id: r.meta.last_row_id });
      }
      if ((m = p.match(/^\/api\/defeitos\/(\d+)\/(recuperar|retrabalho|descartar)$/)) && req.method === 'POST') {
        const d = await one(DB, 'select * from defeito where id=?', Number(m[1]));
        if (!d || !['em_defeito', 'retrabalho'].includes(d.situacao) || (m[2] === 'retrabalho' && d.situacao === 'retrabalho')) return json(req, { erro: 'Defeito já resolvido' }, 400);
        const rtAberto = await one(DB, "select codigo from op where defeito_id=? and status='aberta'", d.id);
        if (rtAberto) return json(req, { erro: `Essa peça está no RT ${rtAberto.codigo - RT_BASE}. Finalize ou cancele o RT.` }, 400);
        const acao = m[2], nomes = { recuperar: 'recuperado', retrabalho: 'retrabalho', descartar: 'descartado' };
        const mov = (dep, qtd, motivo) => DB.prepare('insert into estoque_mov(item_id, deposito_id, qtd, motivo, op_id) values(?,?,?,?,?)').bind(d.item_id, dep, qtd, motivo, d.op_id);
        // conserto (retrabalho) não tira do depósito Defeito: a peça fica lá até ser recuperada ou descartada
        const st = [DB.prepare('update defeito set situacao=?, resolvido_em=?, resolucao_obs=? where id=?').bind(nomes[acao], acao === 'retrabalho' ? null : agora(), body.obs || null, d.id)];
        if (acao !== 'retrabalho') st.push(mov(DEP_DEFEITO, -d.qtd, 'Defeito ' + nomes[acao]));
        if (acao === 'recuperar') st.push(mov(DEP_PA, d.qtd, 'Recuperada do defeito'));
        await DB.batch(st);
        return json(req, { ok: true });
      }

      // ---------- RT (retrabalho): ordem com uma etapa só, "Retrabalho"
      if (p === '/api/rt' && req.method === 'POST') {
        const motivo = String(body.motivo || '').trim();
        if (!motivo) return json(req, { erro: 'Escreva o motivo do retrabalho' }, 400);
        let d = null, itemId = Number(body.item_id), qtd = Number(body.qtd);
        if (body.defeito_id) {
          d = await one(DB, 'select * from defeito where id=?', Number(body.defeito_id));
          if (!d || d.situacao !== 'em_defeito') return json(req, { erro: 'Esse defeito não está mais em aberto' }, 400);
          itemId = d.item_id; qtd = d.qtd;
        }
        const item = await one(DB, 'select * from item where id=?', itemId);
        if (!item || !(qtd > 0)) return json(req, { erro: 'Escolha o item e a quantidade' }, 400);
        const tipoRt = await one(DB, "select id from operacao_tipo where nome='Retrabalho'");
        const mx = await one(DB, "select max(codigo) m from op where tipo='RT'");
        const codigo = Math.max(RT_BASE, (mx && mx.m) || 0) + 1, nome = 'RT ' + (codigo - RT_BASE);
        await DB.prepare("insert into op(codigo, item_id, qtd, previsao_inicio, estagio_id, tipo, motivo, defeito_id, obs) values(?,?,?,?,?,'RT',?,?,?)")
          .bind(codigo, item.id, qtd, agora().slice(0, 10), ESTAGIO_RT, motivo, d ? d.id : null, body.obs || null).run();
        const op = await one(DB, 'select id from op where codigo=?', codigo);
        await DB.batch([
          DB.prepare('insert into op_operacao(op_id, ordem, operacao_tipo_id, tempo_unit_min) values(?,?,?,?)').bind(op.id, 1, tipoRt.id, Number(body.tempo_min) || 0),
          evento(DB, op.id, `${nome} criado: ${qtd} × ${item.nome}. Motivo: ${motivo}` + (d ? ' (peça do Defeito: ao finalizar volta pro P.A. Manaus)' : '')),
          ...(d ? [DB.prepare("update defeito set situacao='retrabalho' where id=?").bind(d.id)] : []),
        ]);
        return json(req, { ok: true, codigo, nome });
      }

      // ---------- OPs
      if (p === '/api/ops' && req.method === 'GET') {
        if (q('status') === 'finalizada')
          return json(req, await opsAbertas(DB, "op.status='finalizada' and op.finalizado_em >= ?", q('desde') || '2000-01-01'));
        return json(req, await opsAbertas(DB));
      }
      if (p === '/api/ops' && req.method === 'POST') {
        const item = await one(DB, 'select * from item where id=?', body.item_id);
        if (!item || !(body.qtd > 0)) return json(req, { erro: 'Escolha o item e a quantidade' }, 400);
        const rot = await all(DB, 'select * from roteiro where item_id=? order by ordem', item.id);
        const comps = await all(DB, `select c.insumo_id, c.qtd, i.nome,
            coalesce((select sum(qtd) from estoque_mov where item_id=c.insumo_id and deposito_id=?),0) saldo
          from composicao c join item i on i.id=c.insumo_id where c.item_id=?`, DEP_PATIO, item.id);
        const falta = comps.filter(c => c.saldo + 1e-9 < c.qtd * body.qtd);
        if (falta.length) return json(req, { erro: 'Sem bloco no Pátio: ' + falta.map(c => `${c.nome} (precisa ${+(c.qtd * body.qtd).toFixed(3)}, tem ${+(+c.saldo).toFixed(3)})`).join('; ') }, 400);
        const max = await one(DB, "select max(codigo) m from op where origem is null and tipo='OP'");
        const codigo = Math.max(5000, (max && max.m) || 0) + 1;
        let pi = null;
        if (body.pedido_item_id) {
          pi = await one(DB, 'select pi.*, p.numero, p.cliente, p.prazo from pedido_item pi join pedido p on p.id=pi.pedido_id where pi.id=?', body.pedido_item_id);
          if (!pi) return json(req, { erro: 'Item de pedido não encontrado' }, 400);
        }
        await DB.prepare('insert into op(codigo, item_id, qtd, previsao_inicio, previsao_fim, estagio_id, pedido, obs, pedido_item_id) values(?,?,?,?,?,?,?,?,?)')
          .bind(codigo, item.id, body.qtd, body.previsao_inicio || agora().slice(0, 10), body.previsao_fim || (pi && pi.prazo) || null, ESTAGIO_INICIAL, pi ? pi.numero : (body.pedido || null), body.obs || null, pi ? pi.id : null).run();
        const op = await one(DB, 'select id from op where codigo=?', codigo);
        await DB.batch([
          ...comps.map(c => DB.prepare('insert into estoque_mov(item_id, deposito_id, qtd, motivo, op_id) values(?,?,?,?,?)')
            .bind(c.insumo_id, DEP_PATIO, -(c.qtd * body.qtd), 'Baixa na criação da OP ' + codigo, op.id)),
          ...(comps.length ? [evento(DB, op.id, 'Blocos baixados do Pátio: ' + comps.map(c => `${+(c.qtd * body.qtd).toFixed(3)} × ${c.nome}`).join(', '))] : []),
          ...rot.map(r => DB.prepare('insert into op_operacao(op_id, ordem, operacao_tipo_id, tempo_unit_min) values(?,?,?,?)').bind(op.id, r.ordem, r.operacao_tipo_id, r.tempo_min)),
          evento(DB, op.id, `OP criada: ${body.qtd} × ${item.nome}` + (pi ? ` para o pedido ${pi.numero} (${pi.cliente})` : ' (estoque)') + (rot.length ? '' : ' (item sem roteiro)')),
        ]);
        return json(req, { ok: true, codigo });
      }
      if ((m = p.match(/^\/api\/ops\/(\d+)$/)) && req.method === 'GET') {
        const op = (await opsAbertas(DB, 'op.codigo=?', Number(m[1])))[0];
        if (!op) return json(req, { erro: 'OP não encontrada' }, 404);
        const [operacoes, eventos, materiais] = await Promise.all([
          all(DB, `select oo.*, t.nome, t.setor_id, t.espera, t.estagio_id, f.nome funcionario, (select x.motivo || coalesce(' – ' || x.obs, '') from op_pausa x where x.op_operacao_id=oo.id and x.fim is null order by x.id desc limit 1) pausa_motivo from op_operacao oo
            join operacao_tipo t on t.id=oo.operacao_tipo_id left join funcionario f on f.id=oo.funcionario_id where oo.op_id=? order by oo.ordem`, op.id),
          all(DB, 'select * from op_evento where op_id=? order by id desc', op.id),
          all(DB, `select i.codigo, i.nome, c.qtd, c.qtd*? total,
            coalesce((select sum(qtd) from estoque_mov where item_id=i.id and deposito_id=?),0) saldo_patio
            from composicao c join item i on i.id=c.insumo_id where c.item_id=?`, op.qtd, DEP_PATIO, op.item_id),
        ]);
        return json(req, { ...op, operacoes, eventos, materiais });
      }
      if ((m = p.match(/^\/api\/ops\/(\d+)\/estagio$/)) && req.method === 'POST') {
        const op = await one(DB, 'select * from op where codigo=?', Number(m[1]));
        const e = await one(DB, 'select * from estagio where id=?', body.estagio_id);
        if (!op || !e || op.status !== 'aberta' || e.id === ESTAGIO_FINAL) return json(req, { erro: 'Movimento inválido' }, 400);
        await DB.batch([DB.prepare('update op set estagio_id=? where id=?').bind(e.id, op.id), evento(DB, op.id, 'Movida para ' + e.nome)]);
        return json(req, { ok: true });
      }
      if ((m = p.match(/^\/api\/ops\/(\d+)\/cancelar$/)) && req.method === 'POST') {
        const op = await one(DB, 'select * from op where codigo=?', Number(m[1]));
        if (!op || op.status !== 'aberta') return json(req, { erro: 'OP não está aberta' }, 400);
        const baixas = await all(DB, 'select item_id, sum(qtd) q from estoque_mov where op_id=? and deposito_id=? group by item_id having q<0', op.id, DEP_PATIO);
        await DB.batch([DB.prepare("update op set status='cancelada' where id=?").bind(op.id), evento(DB, op.id, (op.tipo === 'RT' ? 'RT cancelado' : 'OP cancelada') + (body.motivo ? ': ' + body.motivo : '') + (baixas.length ? ' (blocos devolvidos ao Pátio)' : '') + (op.defeito_id ? ' (peça continua no Defeito)' : '')),
          ...(op.defeito_id ? [DB.prepare("update defeito set situacao='em_defeito' where id=? and situacao='retrabalho'").bind(op.defeito_id)] : []),
          ...baixas.map(b => DB.prepare('insert into estoque_mov(item_id, deposito_id, qtd, motivo, op_id) values(?,?,?,?,?)').bind(b.item_id, DEP_PATIO, -b.q, 'Devolução do cancelamento da OP ' + op.codigo, op.id))]);
        return json(req, { ok: true });
      }

      // ---------- operações (iniciar / pausar / finalizar)
      if ((m = p.match(/^\/api\/operacoes\/(\d+)\/(iniciar|pausar|finalizar|reabrir)$/)) && req.method === 'POST') {
        const oo = await one(DB, `select oo.*, t.nome, t.setor_id, t.espera, op.status op_status, op.codigo, op.qtd op_qtd from op_operacao oo
          join operacao_tipo t on t.id=oo.operacao_tipo_id join op on op.id=oo.op_id where oo.id=?`, Number(m[1]));
        if (!oo || oo.op_status !== 'aberta') return json(req, { erro: 'Operação não encontrada ou OP fechada' }, 400);
        const acao = m[2], now = agora();
        const func = body.funcionario_id ? await one(DB, 'select * from funcionario where id=?', body.funcionario_id) : null;
        const generico = !!body.operador && acao === 'finalizar';
        const quem = func ? func.nome : generico ? 'Operador' : 'Líder';
        let upd;
        if (acao === 'iniciar') {
          if (!['pendente', 'pausado'].includes(oo.status)) return json(req, { erro: 'Operação já está ' + oo.status }, 400);
          if (oo.setor_id && !func && !oo.funcionario_id) return json(req, { erro: 'Escolha quem vai fazer' }, 400);
          upd = DB.prepare("update op_operacao set status='produzindo', funcionario_id=coalesce(?,funcionario_id), inicio=coalesce(inicio,?), inicio_atual=? where id=?")
            .bind(func ? func.id : null, now, now, oo.id);
        } else if (acao === 'pausar') {
          if (oo.status !== 'produzindo') return json(req, { erro: 'Só dá para pausar o que está produzindo' }, 400);
          if (!String(body.motivo || '').trim()) return json(req, { erro: 'Escolha o motivo da pausa' }, 400);
          upd = DB.prepare("update op_operacao set status='pausado', minutos=minutos+?, inicio_atual=null where id=?").bind(minDesde(oo.inicio_atual), oo.id);
        } else if (acao === 'finalizar') {
          if (oo.status === 'finalizado') return json(req, { erro: 'Já finalizada' }, 400);
          if (oo.setor_id && !func && !oo.funcionario_id && !generico) return json(req, { erro: 'Escolha quem fez' }, 400);
          if (generico) {
            const est = Math.round((Number(oo.tempo_unit_min) || 0) * (Number(oo.op_qtd) || 0) * 100) / 100;
            upd = DB.prepare("update op_operacao set status='finalizado', minutos=?, inicio=coalesce(inicio,?), fim=?, inicio_atual=null, sem_registro=2 where id=?").bind(est, now, now, oo.id);
          } else {
          const extra = oo.status === 'produzindo' ? minDesde(oo.inicio_atual) : 0;
          const semReg = !oo.espera && (oo.status === 'pendente' || (Number(oo.minutos) || 0) + extra < 0.01) ? 1 : 0;
          upd = DB.prepare("update op_operacao set status='finalizado', funcionario_id=coalesce(?,funcionario_id), minutos=minutos+?, inicio=coalesce(inicio,?), fim=?, inicio_atual=null, sem_registro=? where id=?")
            .bind(func ? func.id : null, extra, now, now, semReg, oo.id);
          }
        } else {
          if (oo.status !== 'finalizado') return json(req, { erro: 'Só reabre operação finalizada' }, 400);
          upd = DB.prepare("update op_operacao set status='pausado', fim=null, sem_registro=0 where id=?").bind(oo.id);
        }
        const verbo = { iniciar: 'iniciou', pausar: 'pausou', finalizar: 'finalizou', reabrir: 'reabriu' }[acao];
        const motivoPausa = acao === 'pausar' ? ` (motivo: ${String(body.motivo).trim()}${body.obs ? ' – ' + String(body.obs).trim() : ''})` : '';
        const pausaSt = acao === 'pausar'
          ? [DB.prepare('insert into op_pausa(op_operacao_id, motivo, obs, funcionario_id) values(?,?,?,?)').bind(oo.id, String(body.motivo).trim(), body.obs ? String(body.obs).trim() : null, oo.funcionario_id || null)]
          : ['iniciar', 'finalizar'].includes(acao) ? [DB.prepare("update op_pausa set fim=datetime('now') where op_operacao_id=? and fim is null").bind(oo.id)] : [];
        const semTempo = generico ? ' (sem registro: tempo padrão usado como estimado)' : acao === 'finalizar' && !oo.espera && oo.status === 'pendente' ? ' (sem registro de tempo: não foi iniciada)' : '';
        await DB.batch([upd, ...pausaSt, evento(DB, oo.op_id, `${quem} ${verbo} ${oo.nome}${semTempo}${motivoPausa}`)]);
        await recalcularOp(DB, oo.op_id);
        return json(req, { ok: true });
      }

      // fila do setor: operações prontas (a próxima de cada OP) + as que estão produzindo/pausadas
      if (p === '/api/fila') {
        const setor = Number(q('setor_id'));
        const r = await all(DB, `select oo.id, oo.status, oo.ordem, oo.tempo_unit_min, oo.minutos, oo.inicio_atual, t.nome operacao, t.setor_id,
            op.codigo, op.qtd, op.previsao_fim, op.motivo, i.nome item_nome, f.nome funcionario, oo.funcionario_id,
            (select x.motivo || coalesce(' – ' || x.obs, '') from op_pausa x where x.op_operacao_id=oo.id and x.fim is null order by x.id desc limit 1) pausa_motivo,
            (select count(*) from op_operacao x where x.op_id=oo.op_id and x.ordem<oo.ordem and x.status<>'finalizado') antes
          from op_operacao oo join operacao_tipo t on t.id=oo.operacao_tipo_id join op on op.id=oo.op_id join item i on i.id=op.item_id
          left join funcionario f on f.id=oo.funcionario_id
          where op.status='aberta' and oo.status<>'finalizado' and ${setor ? 't.setor_id=?' : 't.espera=1 and ?=0'}
          order by case oo.status when 'produzindo' then 0 when 'pausado' then 1 else 2 end, op.previsao_fim is null, op.previsao_fim, op.codigo`, setor || 0);
        return json(req, r.filter(x => x.status !== 'pendente' || x.antes === 0));
      }

      // ---------- pedidos
      if (p === '/api/pedidos' && req.method === 'GET') {
        const abertos = q('todos') ? '1=1' : "p.status not in ('Entregue','Cancelado','Cancelada')";
        return json(req, await all(DB, `select p.*,
            (select coalesce(sum(qtd),0) from pedido_item where pedido_id=p.id) pecas,
            (select coalesce(sum(o.qtd),0) from op o join pedido_item x on x.id=o.pedido_item_id where x.pedido_id=p.id and o.status<>'cancelada') com_op,
            (select coalesce(sum(o.qtd),0) from op o join pedido_item x on x.id=o.pedido_item_id where x.pedido_id=p.id and o.status='finalizada') prontas_op,
            (select coalesce(sum(conferida),0) from pedido_item where pedido_id=p.id) conferidas,
            (select coalesce(sum(embalada),0) from pedido_item where pedido_id=p.id) embaladas,
            (select coalesce(sum(enviada),0) from pedido_item where pedido_id=p.id) enviadas
          from pedido p where ${abertos} order by p.prazo is null, p.prazo, p.numero`));
      }
      if (p === '/api/pedidos' && req.method === 'POST') {
        if (!body.numero) return json(req, { erro: 'Número do pedido obrigatório' }, 400);
        if (await one(DB, 'select id from pedido where numero=?', String(body.numero))) return json(req, { erro: 'Pedido já existe' }, 400);
        await DB.prepare('insert into pedido(numero, cliente, prazo, data_pagamento, obs) values(?,?,?,?,?)').bind(String(body.numero), body.cliente || null, body.prazo || null, body.data_pagamento || null, body.obs || null).run();
        return json(req, { ok: true });
      }
      if ((m = p.match(/^\/api\/pedidos\/([^/]+)$/)) && req.method === 'GET') {
        const pd = await one(DB, 'select * from pedido where numero=?', decodeURIComponent(m[1]));
        if (!pd) return json(req, { erro: 'Pedido não encontrado' }, 404);
        const itens = await all(DB, `select pi.*, i.codigo item_codigo,
            (select coalesce(sum(qtd),0) from op where pedido_item_id=pi.id and status<>'cancelada') com_op,
            (select coalesce(sum(qtd),0) from op where pedido_item_id=pi.id and status='finalizada') op_fin,
            (select coalesce(sum(qtd),0) from op where pedido_item_id=pi.id and status='aberta' and estagio_id>=11) op_acab,
            (select coalesce(sum(qtd),0) from op where pedido_item_id=pi.id and status='aberta' and estagio_id<11) op_prod,
            (select count(*) from foto where pedido_item_id=pi.id) + (select count(*) from foto f join op o on o.id=f.op_id where o.pedido_item_id=pi.id) fotos
          from pedido_item pi left join item i on i.id=pi.item_id where pi.pedido_id=? order by pi.id`, pd.id);
        const [ops, envios] = await Promise.all([opsAbertas(DB, "pi.pedido_id=? and op.status<>'cancelada'", pd.id),
          all(DB, `select e.*, (select group_concat(cast(ei.qtd as int) || ' × ' || pi.descricao, ' · ') from envio_item ei join pedido_item pi on pi.id=ei.pedido_item_id where ei.envio_id=e.id) itens
            from envio e where e.pedido_id=? order by e.id desc`, pd.id)]);
        return json(req, { ...pd, itens, ops, envios });
      }
      if ((m = p.match(/^\/api\/pedidos\/([^/]+)\/(status|itens)$/)) && req.method === 'POST') {
        const pd = await one(DB, 'select * from pedido where numero=?', decodeURIComponent(m[1]));
        if (!pd) return json(req, { erro: 'Pedido não encontrado' }, 404);
        if (m[2] === 'status') await DB.prepare('update pedido set status=? where id=?').bind(body.status, pd.id).run();
        else {
          const it = await one(DB, 'select * from item where id=?', body.item_id);
          if (!it || !(body.qtd > 0)) return json(req, { erro: 'Escolha o item e a quantidade' }, 400);
          await DB.prepare('insert into pedido_item(pedido_id, item_id, descricao, qtd) values(?,?,?,?)').bind(pd.id, it.id, it.nome, body.qtd).run();
        }
        return json(req, { ok: true });
      }
      // ---------- expedição: conferir / embalar por item de pedido, registrar envio (baixa do P.A.)
      if ((m = p.match(/^\/api\/pedido-itens\/(\d+)\/exp$/)) && req.method === 'POST') {
        const pi = await one(DB, 'select * from pedido_item where id=?', Number(m[1]));
        if (!pi) return json(req, { erro: 'Item não encontrado' }, 404);
        const conf = body.conferida ?? pi.conferida, emb = body.embalada ?? pi.embalada;
        if (conf < 0 || conf > pi.qtd) return json(req, { erro: 'Conferidas tem que ficar entre 0 e ' + pi.qtd }, 400);
        if (emb < pi.enviada) return json(req, { erro: 'Já foram enviadas ' + pi.enviada }, 400);
        if (body.conferida !== undefined && conf < emb) return json(req, { erro: 'Tem peça embalada; tire da embalagem antes' }, 400);
        if (emb > conf) return json(req, { erro: 'Só embala peça conferida' }, 400);
        await DB.prepare('update pedido_item set conferida=?, embalada=? where id=?').bind(conf, emb, pi.id).run();
        const t = await one(DB, 'select sum(qtd) q, sum(embalada) e from pedido_item where pedido_id=?', pi.pedido_id);
        if (t.q > 0 && t.e >= t.q) await DB.prepare("update pedido set status='Pronto / embalagem' where id=? and status='Em produção'").bind(pi.pedido_id).run();
        return json(req, { ok: true });
      }
      if ((m = p.match(/^\/api\/pedidos\/([^/]+)\/envio$/)) && req.method === 'POST') {
        const pd = await one(DB, 'select * from pedido where numero=?', decodeURIComponent(m[1]));
        if (!pd) return json(req, { erro: 'Pedido não encontrado' }, 404);
        const linhas = (body.itens || []).filter(x => x.qtd > 0);
        if (!linhas.length) return json(req, { erro: 'Nenhuma peça no envio' }, 400);
        const its = await all(DB, 'select * from pedido_item where pedido_id=?', pd.id);
        for (const l of linhas) {
          const it = its.find(x => x.id === l.pedido_item_id);
          if (!it) return json(req, { erro: 'Item de outro pedido' }, 400);
          if (l.qtd > it.embalada - it.enviada) return json(req, { erro: `${it.descricao}: só tem ${it.embalada - it.enviada} embalada(s) para enviar` }, 400);
        }
        const r = await DB.prepare('insert into envio(pedido_id, data, transportadora, nf, volumes, obs) values(?,?,?,?,?,?)')
          .bind(pd.id, body.data || agora().slice(0, 10), body.transportadora || null, body.nf || null, body.volumes || null, body.obs || null).run();
        const eid = r.meta.last_row_id, st = [];
        for (const l of linhas) {
          const it = its.find(x => x.id === l.pedido_item_id);
          st.push(DB.prepare('insert into envio_item(envio_id, pedido_item_id, qtd) values(?,?,?)').bind(eid, it.id, l.qtd),
            DB.prepare('update pedido_item set enviada=enviada+? where id=?').bind(l.qtd, it.id));
          if (it.item_id) st.push(DB.prepare('insert into estoque_mov(item_id, deposito_id, qtd, motivo) values(?,?,?,?)').bind(it.item_id, Number(body.deposito_id) === DEP_PA_SP ? DEP_PA_SP : DEP_PA, -l.qtd, `Envio do pedido ${pd.numero} (${pd.cliente || ''})`));
        }
        const falta = its.reduce((s, x) => s + x.qtd - x.enviada, 0) - linhas.reduce((s, l) => s + l.qtd, 0);
        if (falta <= 0) st.push(DB.prepare("update pedido set status='Transportadora' where id=? and status in ('Em produção','Pronto / embalagem')").bind(pd.id));
        await DB.batch(st);
        return json(req, { ok: true, completo: falta <= 0 });
      }

      if (p === '/api/sync/v8' && req.method === 'POST') return json(req, await syncV8(DB, body));
      if (p === '/api/sync/v8') return json(req, await one(DB, "select * from sync_log where origem='v8' order by id desc limit 1"));

      // itens de pedido em aberto que ainda precisam de OP (para escolher ao criar/vincular OP)
      if (p === '/api/pedido-itens') {
        return json(req, await all(DB, `select pi.id, pi.qtd, pi.descricao, pi.etapa_v8, p.numero, p.cliente, p.prazo,
            pi.qtd - (select coalesce(sum(qtd),0) from op where pedido_item_id=pi.id and status<>'cancelada') falta
          from pedido_item pi join pedido p on p.id=pi.pedido_id
          where pi.item_id=? and p.status not in ('Entregue','Cancelado','Cancelada') order by p.prazo is null, p.prazo`, Number(q('item_id'))));
      }
      if ((m = p.match(/^\/api\/ops\/(\d+)\/pedido$/)) && req.method === 'POST') {
        const op = await one(DB, 'select * from op where codigo=?', Number(m[1]));
        if (!op) return json(req, { erro: 'OP não encontrada' }, 404);
        const pi = body.pedido_item_id ? await one(DB, 'select pi.*, p.numero, p.cliente from pedido_item pi join pedido p on p.id=pi.pedido_id where pi.id=?', body.pedido_item_id) : null;
        if (body.pedido_item_id && (!pi || pi.item_id !== op.item_id)) return json(req, { erro: 'Esse item do pedido é de outro produto' }, 400);
        await DB.batch([DB.prepare('update op set pedido_item_id=?, pedido=? where id=?').bind(pi ? pi.id : null, pi ? pi.numero : null, op.id),
          evento(DB, op.id, pi ? `Vinculada ao pedido ${pi.numero} (${pi.cliente})` : 'Desvinculada do pedido (estoque)')]);
        return json(req, { ok: true });
      }

      // ---------- itens
      if (p === '/api/itens') {
        const busca = '%' + (q('q') || '') + '%';
        return json(req, await all(DB, `select i.*, (select count(*) from roteiro r where r.item_id=i.id) n_rot,
            coalesce((select sum(qtd) from estoque_mov where item_id=i.id and deposito_id=?),0) saldo_pa,
            coalesce((select sum(qtd) from estoque_mov where item_id=i.id and deposito_id=?),0) saldo_patio
          from item i where (i.nome like ? or i.codigo like ?) ${q('tipo') ? 'and i.tipo=?' : ''} order by i.tipo desc, i.codigo limit 400`,
          DEP_PA, DEP_PATIO, busca, busca, ...(q('tipo') ? [q('tipo')] : [])));
      }
      if ((m = p.match(/^\/api\/itens\/(\d+)$/)) && req.method === 'GET') {
        const item = await one(DB, 'select * from item where id=?', Number(m[1]));
        if (!item) return json(req, { erro: 'Item não encontrado' }, 404);
        const [composicao, roteiro, estoque] = await Promise.all([
          all(DB, `select c.qtd, i.id, i.codigo, i.nome, coalesce((select sum(qtd) from estoque_mov where item_id=i.id and deposito_id=?),0) saldo_patio
            from composicao c join item i on i.id=c.insumo_id where c.item_id=?`, DEP_PATIO, item.id),
          all(DB, 'select r.ordem, r.tempo_min, t.nome, t.espera from roteiro r join operacao_tipo t on t.id=r.operacao_tipo_id where r.item_id=? order by r.ordem', item.id),
          all(DB, 'select d.nome, sum(m.qtd) saldo from estoque_mov m join deposito d on d.id=m.deposito_id where m.item_id=? group by d.id having abs(saldo)>0.0001', item.id),
        ]);
        return json(req, { ...item, composicao, roteiro, estoque });
      }
      if ((m = p.match(/^\/api\/itens\/(\d+)\/roteiro$/)) && req.method === 'POST') {
        await DB.prepare('update roteiro set tempo_min=? where item_id=? and ordem=?').bind(Number(body.tempo_min), Number(m[1]), Number(body.ordem)).run();
        return json(req, { ok: true });
      }

      // ---------- estoque
      if (p === '/api/estoque' && req.method === 'GET') {
        const dep = Number(q('deposito_id') || DEP_PATIO);
        const l = await all(DB, `select i.id, i.codigo, i.nome, i.tipo, sum(m.qtd) saldo from estoque_mov m join item i on i.id=m.item_id
          where m.deposito_id=? group by i.id having abs(saldo)>0.0001 order by i.codigo`, dep);
        if (dep === DEP_PA) {
          // classe por item: considera que as peças no P.A. são as classificadas mais recentes (as mais antigas já saíram)
          const cl = await all(DB, `select o.item_id, q.classe from peca_qualidade q join op o on o.id=q.op_id order by o.finalizado_em desc, q.numero`);
          const por = {}; cl.forEach(c => (por[c.item_id] = por[c.item_id] || []).push(c.classe));
          l.forEach(i => { const n = Math.max(0, Math.floor(i.saldo + 1e-9)), k = (por[i.id] || []).slice(0, n); if (k.length) { i.classes = { A: 0, B: 0, C: 0, D: 0 }; k.forEach(c => i.classes[c]++); i.sem_classe = n - k.length; } });
        }
        return json(req, l);
      }
      if (p === '/api/estoque/mov' && req.method === 'POST') {
        if (!body.item_id || !body.deposito_id || !Number(body.qtd)) return json(req, { erro: 'Item, depósito e quantidade' }, 400);
        await DB.prepare('insert into estoque_mov(item_id, deposito_id, qtd, motivo) values(?,?,?,?)').bind(body.item_id, body.deposito_id, Number(body.qtd), body.motivo || 'Ajuste manual').run();
        return json(req, { ok: true });
      }
      if (p === '/api/estoque/movs') {
        return json(req, await all(DB, `select m.*, i.codigo, i.nome, d.nome deposito from estoque_mov m join item i on i.id=m.item_id
          join deposito d on d.id=m.deposito_id order by m.id desc limit 100`));
      }

      // ---------- inventário (contagem física por depósito; ao fechar, ajusta o saldo pela diferença)
      if (p === '/api/inventarios' && req.method === 'GET') {
        return json(req, await all(DB, `select v.*, d.nome deposito, (select count(*) from inventario_item where inventario_id=v.id) itens,
            (select count(*) from inventario_item where inventario_id=v.id and contado is not null) contados,
            (select count(*) from inventario_item where inventario_id=v.id and abs(coalesce(ajuste,0))>0.0001) com_ajuste
          from inventario v join deposito d on d.id=v.deposito_id where v.status<>'cancelado' order by v.id desc limit 50`));
      }
      if (p === '/api/inventarios' && req.method === 'POST') {
        const dep = await one(DB, 'select * from deposito where id=?', body.deposito_id);
        if (!dep) return json(req, { erro: 'Escolha o depósito' }, 400);
        const aberto = await one(DB, "select id from inventario where deposito_id=? and status='aberto'", dep.id);
        if (aberto) return json(req, { id: aberto.id, ja_aberto: true });
        const r = await DB.prepare('insert into inventario(deposito_id, obs) values(?,?)').bind(dep.id, body.obs || null).run();
        const id = r.meta.last_row_id, tipo = dep.id === DEP_PATIO ? 'Matéria-prima' : 'Produto';
        await DB.prepare(`insert into inventario_item(inventario_id, item_id, saldo_sistema)
          select ?, i.id, coalesce((select sum(qtd) from estoque_mov where item_id=i.id and deposito_id=?),0) from item i
          where (i.tipo=? and i.ativo=1) or exists(select 1 from estoque_mov m where m.item_id=i.id and m.deposito_id=? group by m.item_id having abs(sum(m.qtd))>0.0001)`)
          .bind(id, dep.id, tipo, dep.id).run();
        return json(req, { id });
      }
      if ((m = p.match(/^\/api\/inventarios\/(\d+)$/)) && req.method === 'GET') {
        const v = await one(DB, 'select v.*, d.nome deposito from inventario v join deposito d on d.id=v.deposito_id where v.id=?', Number(m[1]));
        if (!v) return json(req, { erro: 'Inventário não encontrado' }, 404);
        const itens = await all(DB, `select ii.*, i.codigo, i.nome, coalesce((select sum(qtd) from estoque_mov where item_id=ii.item_id and deposito_id=?),0) saldo_atual
          from inventario_item ii join item i on i.id=ii.item_id where ii.inventario_id=? order by i.codigo`, v.deposito_id, v.id);
        return json(req, { ...v, itens });
      }
      if ((m = p.match(/^\/api\/inventarios\/(\d+)\/(contagem|fechar|cancelar)$/)) && req.method === 'POST') {
        const v = await one(DB, 'select * from inventario where id=?', Number(m[1]));
        if (!v || v.status !== 'aberto') return json(req, { erro: 'Inventário já fechado' }, 400);
        if (m[2] === 'contagem') {
          const c = body.contado === null || body.contado === '' ? null : Number(body.contado);
          if (c !== null && !(c >= 0)) return json(req, { erro: 'Quantidade inválida' }, 400);
          await DB.prepare('update inventario_item set contado=? where inventario_id=? and item_id=?').bind(c, v.id, body.item_id).run();
          return json(req, { ok: true });
        }
        if (m[2] === 'cancelar') { await DB.prepare("update inventario set status='cancelado', fechado_em=? where id=?").bind(agora(), v.id).run(); return json(req, { ok: true }); }
        const its = await all(DB, `select ii.*, coalesce((select sum(qtd) from estoque_mov where item_id=ii.item_id and deposito_id=?),0) saldo_atual
          from inventario_item ii where ii.inventario_id=?`, v.deposito_id, v.id);
        const st = []; let n = 0;
        for (const it of its) {
          const c = it.contado !== null ? it.contado : (body.zerar_nao_contados ? 0 : null);
          if (c === null) continue;
          const dif = Math.round((c - it.saldo_atual) * 1000) / 1000;
          st.push(DB.prepare('update inventario_item set contado=?, ajuste=? where id=?').bind(c, dif, it.id));
          if (Math.abs(dif) > 0.0001) { n++; st.push(DB.prepare('insert into estoque_mov(item_id, deposito_id, qtd, motivo) values(?,?,?,?)').bind(it.item_id, v.deposito_id, dif, `Inventário nº ${v.id} (contado ${c})`)); }
        }
        st.push(DB.prepare("update inventario set status='fechado', fechado_em=? where id=?").bind(agora(), v.id));
        await DB.batch(st);
        return json(req, { ok: true, ajustes: n });
      }

      // ---------- entrada de madeira (blocos que chegam no Pátio)
      if (p === '/api/entradas' && req.method === 'GET') {
        return json(req, await all(DB, `select e.*, (select group_concat(cast(ei.qtd as text) || ' × ' || i.nome, ' · ') from entrada_item ei join item i on i.id=ei.item_id where ei.entrada_id=e.id) itens,
          (select sum(qtd) from entrada_item where entrada_id=e.id) total from entrada e order by e.id desc limit 100`));
      }
      if (p === '/api/entradas' && req.method === 'POST') {
        const linhas = (body.itens || []).filter(x => x.item_id && x.qtd > 0);
        if (!linhas.length) return json(req, { erro: 'Coloque pelo menos um bloco e a quantidade' }, 400);
        const r = await DB.prepare('insert into entrada(data, fornecedor, nf, obs) values(?,?,?,?)').bind(body.data || agora().slice(0, 10), body.fornecedor || null, body.nf || null, body.obs || null).run();
        const id = r.meta.last_row_id, txt = `Entrada de madeira nº ${id}` + (body.fornecedor ? ' · ' + body.fornecedor : '') + (body.nf ? ' · NF ' + body.nf : '');
        await DB.batch(linhas.flatMap(l => [DB.prepare('insert into entrada_item(entrada_id, item_id, qtd) values(?,?,?)').bind(id, l.item_id, l.qtd),
          DB.prepare('insert into estoque_mov(item_id, deposito_id, qtd, motivo) values(?,?,?,?)').bind(l.item_id, DEP_PATIO, l.qtd, txt)]));
        return json(req, { ok: true, id });
      }

      // ---------- PCP quinzenal: sugere o que cortar com o bloco que tem no Pátio, cria as OPs e acompanha plano x realizado
      if (p === '/api/pcp/sugestao') {
        const falta = await all(DB, `select pi.id pedido_item_id, pi.item_id, i.nome, i.codigo, p.numero, p.cliente, p.prazo,
            pi.qtd - pi.conferida - (select coalesce(sum(qtd),0) from op where pedido_item_id=pi.id and status<>'cancelada') falta
          from pedido_item pi join pedido p on p.id=pi.pedido_id join item i on i.id=pi.item_id
          where p.status in ('Em produção','Pronto / embalagem') and pi.item_id is not null
            and pi.qtd - pi.conferida - (select coalesce(sum(qtd),0) from op where pedido_item_id=pi.id and status<>'cancelada') > 0
          order by p.prazo is null, p.prazo, p.numero`);
        const comps = await all(DB, `select c.item_id, c.insumo_id, c.qtd, i.nome from composicao c join item i on i.id=c.insumo_id`);
        const saldo = {}; for (const s of await all(DB, 'select item_id, sum(qtd) q from estoque_mov where deposito_id=? group by item_id', DEP_PATIO)) saldo[s.item_id] = s.q;
        const resto = { ...saldo }, out = [];
        for (const f of falta) {
          const cs = comps.filter(c => c.item_id === f.item_id);
          let pode = f.falta;
          for (const c of cs) pode = Math.min(pode, Math.floor(((resto[c.insumo_id] || 0) + 1e-9) / c.qtd));
          pode = Math.max(0, pode);
          for (const c of cs) resto[c.insumo_id] = (resto[c.insumo_id] || 0) - c.qtd * pode;
          out.push({ ...f, pode, sem_composicao: !cs.length, blocos: cs.map(c => `${+(c.qtd * f.falta).toFixed(3)} × ${c.nome} (Pátio: ${+(+(saldo[c.insumo_id] || 0)).toFixed(3)})`).join(', ') });
        }
        const precisa = {};
        for (const f of out) for (const c of comps.filter(c => c.item_id === f.item_id)) precisa[c.insumo_id] = { nome: c.nome, q: ((precisa[c.insumo_id] || {}).q || 0) + c.qtd * f.falta, tem: saldo[c.insumo_id] || 0 };
        return json(req, { itens: out, madeira: Object.values(precisa).map(x => ({ ...x, falta: Math.max(0, x.q - x.tem) })).sort((a, b) => b.falta - a.falta) });
      }
      if (p === '/api/pcp' && req.method === 'GET') {
        return json(req, await all(DB, `select c.*, count(ci.id) itens, sum(ci.qtd) pecas,
            sum(case when o.status='finalizada' then ci.qtd else 0 end) prontas, sum(case when o.status='cancelada' then ci.qtd else 0 end) canceladas
          from pcp c left join pcp_item ci on ci.pcp_id=c.id left join op o on o.id=ci.op_id group by c.id order by c.id desc limit 30`));
      }
      if (p === '/api/pcp' && req.method === 'POST') {
        if (!body.inicio || !body.fim) return json(req, { erro: 'Período da quinzena' }, 400);
        const r = await DB.prepare('insert into pcp(inicio, fim, obs) values(?,?,?)').bind(body.inicio, body.fim, body.obs || null).run();
        return json(req, { id: r.meta.last_row_id });
      }
      if ((m = p.match(/^\/api\/pcp\/(\d+)$/)) && req.method === 'GET') {
        const c = await one(DB, 'select * from pcp where id=?', Number(m[1]));
        if (!c) return json(req, { erro: 'PCP não encontrado' }, 404);
        const itens = await all(DB, `select ci.*, i.nome, i.codigo, o.codigo op_codigo, o.status op_status, o.finalizado_em, e.nome estagio, pd.numero, pd.cliente
          from pcp_item ci join item i on i.id=ci.item_id left join op o on o.id=ci.op_id left join estagio e on e.id=o.estagio_id
          left join pedido_item pi on pi.id=ci.pedido_item_id left join pedido pd on pd.id=pi.pedido_id where ci.pcp_id=? order by ci.id`, c.id);
        return json(req, { ...c, itens });
      }
      if ((m = p.match(/^\/api\/pcp\/(\d+)\/item$/)) && req.method === 'POST') {
        // a OP já foi criada pelo /api/ops; aqui só registra no plano
        const op = await one(DB, 'select * from op where codigo=?', Number(body.op_codigo));
        if (!op) return json(req, { erro: 'OP não encontrada' }, 400);
        await DB.prepare('insert into pcp_item(pcp_id, item_id, pedido_item_id, qtd, op_id) values(?,?,?,?,?)').bind(Number(m[1]), op.item_id, op.pedido_item_id, op.qtd, op.id).run();
        return json(req, { ok: true });
      }

      // ---------- painel da fábrica
      if (p === '/api/painel') {
        const hoje = agora().slice(0, 10), seg = new Date(Date.now() - ((new Date().getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10);
        const [ops, atrasadas, pedidos, hojeProd, semanaProd, estagios, defeitos, faltas, parados, envios] = await Promise.all([
          one(DB, "select count(*) n, coalesce(sum(qtd),0) pecas from op where status='aberta'"),
          all(DB, `select op.codigo, op.qtd, op.previsao_fim, i.nome, e.nome estagio from op join item i on i.id=op.item_id join estagio e on e.id=op.estagio_id
            where op.status='aberta' and op.previsao_fim < ? order by op.previsao_fim limit 20`, hoje),
          all(DB, `select p.numero, p.cliente, p.prazo, p.status, (select sum(qtd) from pedido_item where pedido_id=p.id) pecas,
            (select sum(conferida) from pedido_item where pedido_id=p.id) conferidas, (select sum(enviada) from pedido_item where pedido_id=p.id) enviadas
            from pedido p where p.status in ('Em produção','Pronto / embalagem') and p.prazo is not null and p.prazo <= date(?, '+7 days') order by p.prazo`, hoje),
          one(DB, "select count(*) ops, coalesce(sum(o.qtd),0) pecas from op_operacao oo join op o on o.id=oo.op_id where oo.status='finalizado' and oo.fim >= ?", hoje + ' 00:00:00'),
          one(DB, "select count(*) n, coalesce(sum(qtd),0) pecas from op where status='finalizada' and finalizado_em >= ?", seg + ' 00:00:00'),
          all(DB, "select e.nome, count(op.id) ops, coalesce(sum(op.qtd),0) pecas from estagio e left join op on op.estagio_id=e.id and op.status='aberta' where e.ordem between 2 and 11 group by e.id order by e.ordem"),
          one(DB, 'select coalesce(sum(qtd),0) n from defeito where data >= ?', seg + ' 00:00:00'),
          all(DB, "select f.nome, pr.status, pr.minutos from presenca pr join funcionario f on f.id=pr.funcionario_id where pr.data=? and pr.status is not null", hoje),
          all(DB, `select o.codigo, i.nome, t.nome operacao, oo.inicio from op_operacao oo join op o on o.id=oo.op_id join item i on i.id=o.item_id join operacao_tipo t on t.id=oo.operacao_tipo_id
            where o.status='aberta' and t.espera=1 and oo.status='produzindo' and oo.inicio < datetime('now','-10 days') order by oo.inicio limit 15`),
          one(DB, 'select count(*) n, coalesce(sum(ei.qtd),0) pecas from envio e join envio_item ei on ei.envio_id=e.id where e.data >= ?', seg),
        ]);
        // quem está produzindo agora (etapas iniciadas ou pausadas, fora as de espera)
        const agoraProd = await all(DB, `select oo.status, oo.minutos, oo.inicio_atual, (select x.motivo || coalesce(' – ' || x.obs, '') from op_pausa x where x.op_operacao_id=oo.id and x.fim is null order by x.id desc limit 1) pausa_motivo, (select x.inicio from op_pausa x where x.op_operacao_id=oo.id and x.fim is null order by x.id desc limit 1) pausa_inicio, oo.tempo_unit_min*o.qtd padrao, o.codigo, o.qtd, i.nome item, t.nome operacao, f.nome funcionario, s.nome setor
          from op_operacao oo join op o on o.id=oo.op_id join item i on i.id=o.item_id join operacao_tipo t on t.id=oo.operacao_tipo_id
          left join funcionario f on f.id=oo.funcionario_id left join setor s on s.id=t.setor_id
          where o.status='aberta' and t.espera=0 and oo.status in ('produzindo','pausado') order by oo.status='pausado', s.id, f.nome`);
        // evolução semanal: S39–S46 dos relatórios do Drive (historico_semana) + semanas medidas no sistema (desde 23/11/2026)
        const [hist, sis, dias] = await Promise.all([
          all(DB, 'select * from historico_semana order by semana'),
          all(DB, `select date(date(op.finalizado_em, '-4 hours'), '-' || ((cast(strftime('%w', date(op.finalizado_em, '-4 hours')) as int) + 6) % 7) || ' days') inicio,
              sum(op.qtd) pecas, sum(case when i.nome like 'Banco%' then op.qtd else 0 end) bancos
            from op join item i on i.id=op.item_id where op.status='finalizada' and op.tipo='OP' and date(op.finalizado_em, '-4 hours') >= '2026-11-23' group by inicio order by inicio`),
          all(DB, `select date(oo.fim, '-4 hours') dia, t.setor_id, count(*) etapas from op_operacao oo join operacao_tipo t on t.id=oo.operacao_tipo_id join op on op.id=oo.op_id
            where oo.status='finalizado' and t.espera=0 and t.setor_id is not null and date(oo.fim, '-4 hours') >= date('now', '-4 hours', '-13 days') group by dia, t.setor_id`),
        ]);
        const semanas = hist.map(h => ({ semana: h.semana, inicio: h.inicio, pecas: h.pecas_op || 0, bancos: h.bancos || 0, regularizacao: h.regularizacao || 0, fonte: 'relatorio', obs: h.obs }));
        const ultimo = hist.length ? hist[hist.length - 1] : null;
        sis.forEach(x => { if (ultimo && x.inicio <= ultimo.inicio) return; const n = ultimo ? ultimo.semana + Math.round((Date.parse(x.inicio) - Date.parse(ultimo.inicio)) / 6048e5) : 0;
          semanas.push({ semana: n, inicio: x.inicio, pecas: x.pecas || 0, bancos: x.bancos || 0, regularizacao: 0, fonte: 'sistema' }); });
        if (ultimo) { const segAtual = new Date(Date.now() - 4 * 36e5); segAtual.setUTCDate(segAtual.getUTCDate() - ((segAtual.getUTCDay() + 6) % 7)); const ini = segAtual.toISOString().slice(0, 10);
          if (ini > ultimo.inicio && !semanas.find(x => x.inicio === ini)) semanas.push({ semana: ultimo.semana + Math.round((Date.parse(ini) - Date.parse(ultimo.inicio)) / 6048e5), inicio: ini, pecas: 0, bancos: 0, regularizacao: 0, fonte: 'sistema' }); }
        return json(req, { hoje, seg, ops, atrasadas, pedidos, hojeProd, semanaProd, estagios, defeitos: defeitos.n, faltas, parados, envios, agoraProd, semanas, dias });
      }

      // ---------- relatório semanal (junta tudo da semana)
      if (p === '/api/semana') {
        const de = q('de'), ate = q('ate'), d0 = de + ' 00:00:00', d1 = ate + ' 23:59:59';
        const [finalizadas, criadas, envios, entradas, inventarios] = await Promise.all([
          all(DB, `select o.codigo, o.qtd, i.nome, pd.numero from op o join item i on i.id=o.item_id left join pedido_item pi on pi.id=o.pedido_item_id left join pedido pd on pd.id=pi.pedido_id
            where o.status='finalizada' and o.finalizado_em between ? and ? order by o.finalizado_em`, d0, d1),
          one(DB, "select count(*) n, coalesce(sum(qtd),0) pecas from op where origem is null and criado_em between ? and ?", d0, d1),
          all(DB, `select e.data, p.numero, p.cliente, e.transportadora, (select sum(qtd) from envio_item where envio_id=e.id) pecas from envio e join pedido p on p.id=e.pedido_id
            where e.data between ? and ? order by e.data`, de, ate),
          all(DB, `select e.data, e.fornecedor, (select sum(qtd) from entrada_item where entrada_id=e.id) qtd from entrada e where e.data between ? and ?`, de, ate),
          all(DB, `select v.id, d.nome deposito, (select count(*) from inventario_item where inventario_id=v.id and abs(coalesce(ajuste,0))>0.0001) ajustes from inventario v join deposito d on d.id=v.deposito_id
            where v.status='fechado' and v.fechado_em between ? and ?`, d0, d1),
        ]);
        return json(req, { finalizadas, criadas, envios, entradas, inventarios });
      }

      // ---------- fotos (guardadas no banco já reduzidas pelo navegador)
      if (p === '/api/fotos' && req.method === 'GET') {
        const campo = q('op_id') ? 'op_id' : q('defeito_id') ? 'defeito_id' : q('pedido_item_id') ? 'pedido_item_id' : q('qualidade_id') ? 'qualidade_id' : null;
        if (q('pedido')) return json(req, await all(DB, `select * from (
            select f.id, f.nome, f.criado_em, i.codigo, i.nome item, o.codigo op_codigo from foto f join op o on o.id=f.op_id join item i on i.id=o.item_id
              join pedido_item pi on pi.id=o.pedido_item_id join pedido pd on pd.id=pi.pedido_id where pd.numero=?
            union all
            select f.id, f.nome, f.criado_em, coalesce(i.codigo, pi.descricao) codigo, coalesce(i.nome, pi.descricao) item, null op_codigo from foto f join pedido_item pi on pi.id=f.pedido_item_id
              left join item i on i.id=pi.item_id join pedido pd on pd.id=pi.pedido_id where pd.numero=?) order by codigo, id`, q('pedido'), q('pedido')));
        if (!campo) return json(req, []);
        return json(req, await all(DB, `select id, nome, criado_em from foto where ${campo}=? order by id`, Number(q(campo))));
      }
      if ((m = p.match(/^\/api\/fotos\/(\d+)$/)) && req.method === 'GET') {
        const f = await one(DB, 'select dados from foto where id=?', Number(m[1]));
        if (!f) return new Response('não achei', { status: 404, headers: cors(req) });
        const b64 = f.dados.split(',')[1], bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        return new Response(bin, { headers: { ...cors(req), 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' } });
      }
      if (p === '/api/fotos' && req.method === 'POST') {
        if (!String(body.dados || '').startsWith('data:image/jpeg;base64,') || body.dados.length > 1500000) return json(req, { erro: 'Foto inválida ou grande demais' }, 400);
        if (!body.op_id && !body.defeito_id && !body.pedido_item_id && !body.qualidade_id) return json(req, { erro: 'Foto sem OP/defeito/pedido' }, 400);
        const r = await DB.prepare('insert into foto(op_id, defeito_id, pedido_item_id, qualidade_id, nome, dados) values(?,?,?,?,?,?)').bind(body.op_id || null, body.defeito_id || null, body.pedido_item_id || null, body.qualidade_id || null, body.nome || null, body.dados).run();
        return json(req, { ok: true, id: r.meta.last_row_id });
      }
      if ((m = p.match(/^\/api\/fotos\/(\d+)\/apagar$/)) && req.method === 'POST') {
        await DB.prepare('delete from foto where id=?').bind(Number(m[1])).run();
        return json(req, { ok: true });
      }

      // ---------- controle de qualidade: classificação A/B/C/D de cada peça das OPs finalizadas (só registro, não mexe no estoque)
      if (p === '/api/qualidade' && req.method === 'GET') {
        const dias = Math.min(365, Number(q('dias')) || 60);
        const l = await all(DB, `select o.codigo, o.qtd, o.finalizado_em, i.codigo item_codigo, i.nome item, pd.numero pedido_numero, pd.cliente pedido_cliente,
            (select count(*) from peca_qualidade q where q.op_id=o.id) feitas,
            (select group_concat(classe, '') from (select classe from peca_qualidade q where q.op_id=o.id order by numero)) classes
          from op o join item i on i.id=o.item_id left join pedido_item pi on pi.id=o.pedido_item_id left join pedido pd on pd.id=pi.pedido_id
          where o.status='finalizada' and o.tipo='OP' and o.finalizado_em >= datetime('now', ?) order by o.finalizado_em desc`, `-${dias} days`);
        return json(req, l.map(o => ({ ...o, pecas: Math.max(1, Math.ceil(o.qtd - 1e-9)) })));
      }
      if (p === '/api/qualidade/resumo') {
        const de = q('de') + ' 00:00:00', ate = q('ate') + ' 23:59:59';
        const [porClasse, porItem] = await Promise.all([
          all(DB, 'select classe, count(*) n from peca_qualidade where criado_em between ? and ? group by classe', de, ate),
          all(DB, `select i.nome item, sum(q.classe='A') A, sum(q.classe='B') B, sum(q.classe='C') C, sum(q.classe='D') D, count(*) n
            from peca_qualidade q join op o on o.id=q.op_id join item i on i.id=o.item_id where q.criado_em between ? and ? group by i.id order by n desc limit 30`, de, ate)]);
        return json(req, { porClasse, porItem });
      }
      if ((m = p.match(/^\/api\/qualidade\/op\/(\d+)$/)) && req.method === 'GET') {
        const o = await one(DB, `select o.id, o.codigo, o.qtd, o.status, o.finalizado_em, i.codigo item_codigo, i.nome item from op o join item i on i.id=o.item_id where o.codigo=?`, Number(m[1]));
        if (!o) return json(req, { erro: 'OP não encontrada' }, 404);
        const pecas = await all(DB, `select q.*, (select count(*) from foto f where f.qualidade_id=q.id) fotos from peca_qualidade q where q.op_id=? order by numero`, o.id);
        return json(req, { ...o, total: Math.max(1, Math.ceil(o.qtd - 1e-9)), pecas });
      }
      if ((m = p.match(/^\/api\/qualidade\/op\/(\d+)\/(\d+)$/)) && req.method === 'POST') {
        const o = await one(DB, "select id, qtd, status, tipo from op where codigo=?", Number(m[1])), n = Number(m[2]);
        if (!o || o.status !== 'finalizada' || o.tipo !== 'OP') return json(req, { erro: 'Só classifica peça de OP finalizada' }, 400);
        if (n < 1 || n > Math.max(1, Math.ceil(o.qtd - 1e-9))) return json(req, { erro: 'Número da peça fora da OP' }, 400);
        if (!['A', 'B', 'C', 'D'].includes(body.classe)) return json(req, { erro: 'Classe tem que ser A, B, C ou D' }, 400);
        await DB.prepare(`insert into peca_qualidade(op_id, numero, classe, obs) values(?,?,?,?)
          on conflict(op_id, numero) do update set classe=excluded.classe, obs=excluded.obs, atualizado_em=datetime('now')`).bind(o.id, n, body.classe, body.obs || null).run();
        const r = await one(DB, 'select id from peca_qualidade where op_id=? and numero=?', o.id, n);
        await evento(DB, o.id, `Qualidade: peça ${n} classificada ${body.classe}` + (body.obs ? ` (${body.obs})` : '')).run();
        return json(req, { ok: true, id: r.id });
      }

      // ---------- metas de peças por dia (por família de peça e setor)
      if (p === '/api/metas' && req.method === 'GET') return json(req, await all(DB, 'select * from meta order by nome, setor_id'));
      if (p === '/api/metas' && req.method === 'POST') {
        if (!usuario.admin) return json(req, { erro: 'Só o administrador muda as metas' }, 403);
        const l = Array.isArray(body.metas) ? body.metas : [];
        await DB.batch(l.map(x => Number(x.pecas_dia) > 0
          ? DB.prepare('insert into meta(chave, nome, setor_id, pecas_dia) values(?,?,?,?) on conflict(chave, setor_id) do update set pecas_dia=excluded.pecas_dia, nome=excluded.nome').bind(x.chave, x.nome, x.setor_id, Number(x.pecas_dia))
          : DB.prepare('delete from meta where chave=? and setor_id=?').bind(x.chave, x.setor_id)));
        return json(req, { ok: true });
      }

      // ---------- eficiência por funcionário = peças feitas ÷ meta de peças por dia (por dia trabalhado), + defeitos/RT + evolução semanal
      if (p === '/api/eficiencia') {
        const de = q('de'), ate = q('ate'), setor = Number(q('setor_id')) || 0;
        const fs = setor ? 'and f.setor_id=' + setor : '';
        const desde = new Date(Date.parse(ate + 'T12:00:00Z') - 63 * 864e5).toISOString().slice(0, 10);
        const ini = de < desde ? de : desde;
        const sem = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
        const [metas, etapas, somas, extra, defs, funcs] = await Promise.all([
          all(DB, 'select chave, nome, setor_id, pecas_dia from meta'),
          all(DB, `select oo.funcionario_id fid, oo.op_id, oo.tempo_unit_min tu, t.setor_id, op.qtd, i.nome item, date(oo.fim, '-4 hours') dia
            from op_operacao oo join op on op.id=oo.op_id join operacao_tipo t on t.id=oo.operacao_tipo_id join item i on i.id=op.item_id join funcionario f on f.id=oo.funcionario_id
            where oo.status='finalizado' and t.espera=0 and op.tipo='OP' and t.setor_id is not null and date(oo.fim, '-4 hours') between ? and ? ${fs}`, ini, ate),
          all(DB, `select oo.op_id, t.setor_id, sum(oo.tempo_unit_min) s, count(*) n from op_operacao oo join operacao_tipo t on t.id=oo.operacao_tipo_id
            where t.espera=0 and oo.op_id in (select op_id from op_operacao where status='finalizado' and date(fim, '-4 hours') between ? and ?) group by oo.op_id, t.setor_id`, ini, ate),
          all(DB, `select f.id, sum(op.tipo='OP' and oo.sem_registro=1) sem_registro, sum(op.tipo='RT') rt_feitos, sum(case when op.tipo='RT' then oo.minutos else 0 end) rt_minutos,
              sum(case when op.tipo='OP' and oo.sem_registro=0 and oo.minutos>=1 then oo.minutos else 0 end) minutos,
              sum(case when op.tipo='OP' and oo.sem_registro=0 and oo.minutos>=1 then oo.tempo_unit_min*op.qtd else 0 end) padrao
            from op_operacao oo join op on op.id=oo.op_id join operacao_tipo t on t.id=oo.operacao_tipo_id join funcionario f on f.id=oo.funcionario_id
            where oo.status='finalizado' and t.espera=0 and date(oo.fim, '-4 hours') between ? and ? ${fs} group by f.id`, de, ate),
          all(DB, `select d.funcionario_id id, count(*) regs, sum(d.qtd) pecas, sum((select count(*) from op x where x.defeito_id=d.id)) rts
            from defeito d where d.funcionario_id is not null and date(d.data, '-4 hours') between ? and ? group by d.funcionario_id`, de, ate),
          all(DB, `select f.id, f.nome, f.setor_id, s.nome setor from funcionario f left join setor s on s.id=f.setor_id where f.ativo=1 ${fs} order by f.nome`),
        ]);
        const M = {}, NM = {}; metas.forEach(m => { (M[m.chave] = M[m.chave] || {})[m.setor_id] = m.pecas_dia; NM[m.chave] = m.nome; });
        const chaves = Object.keys(M).sort((a, b) => b.length - a.length);
        const S = {}; somas.forEach(x => S[x.op_id + '|' + x.setor_id] = x);
        const seg = d => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
        const P = {}; funcs.forEach(f => P[f.id] = { ...f, credito: 0, pecas_meta: 0, dias: new Set(), sem_meta: 0, semanas: {}, porPeca: {} });
        for (const e of etapas) {
          const f = P[e.fid]; if (!f) continue;
          const so = S[e.op_id + '|' + e.setor_id], share = so && so.s > 0 ? (Number(e.tu) || 0) / so.s : 1 / ((so && so.n) || 1);
          const eq = Number(e.qtd) * share, ch = chaves.find(k => sem(e.item).includes(k)), meta = ch && M[ch][e.setor_id];
          const w = seg(e.dia), sw = f.semanas[w] = f.semanas[w] || { credito: 0, dias: new Set() };
          sw.dias.add(e.dia);
          if (meta) sw.credito += eq / meta;
          if (e.dia >= de && e.dia <= ate) {
            f.dias.add(e.dia);
            if (meta) { f.credito += eq / meta; f.pecas_meta += eq; const pp = f.porPeca[ch] = f.porPeca[ch] || { pecas: 0, meta }; pp.pecas += eq; } else f.sem_meta++;
          }
        }
        const X = {}; extra.forEach(x => X[x.id] = x); const D = {}; defs.forEach(d => D[d.id] = d);
        const lista = Object.values(P).map(f => {
          const x = X[f.id] || {}, d = D[f.id] || {}, dias = f.dias.size;
          const semanas = {}; Object.entries(f.semanas).forEach(([w, v]) => { if (v.dias.size) semanas[w] = Math.round(v.credito / v.dias.size * 100); });
          return { id: f.id, nome: f.nome, setor: f.setor, setor_id: f.setor_id, dias, pecas: Math.round(f.pecas_meta * 10) / 10, sem_meta: f.sem_meta,
            eficiencia: dias ? Math.round(f.credito / dias * 100) : null, metas_cumpridas: Math.round(f.credito * 100) / 100,
            porPeca: Object.entries(f.porPeca).map(([k, v]) => ({ peca: NM[k] || k, pecas: Math.round(v.pecas * 10) / 10, meta: v.meta })),
            eficiencia_tempo: x.minutos > 0 ? Math.round(x.padrao / x.minutos * 100) : null,
            sem_registro: x.sem_registro || 0, rt_feitos: x.rt_feitos || 0, rt_minutos: x.rt_minutos || 0,
            defeitos: d.regs || 0, pecas_defeito: d.pecas || 0, rts_gerados: d.rts || 0, semanas };
        }).sort((a, b) => (b.eficiencia ?? -1) - (a.eficiencia ?? -1) || b.pecas - a.pecas || a.nome.localeCompare(b.nome));
        return json(req, { lista });
      }

      // ---------- relatório de produção (operações finalizadas no período)
      if (p === '/api/relatorio') {
        const de = q('de') + ' 00:00:00', ate = q('ate') + ' 23:59:59';
        const porPessoa = await all(DB, `select f.id, f.nome funcionario, s.nome setor, count(*) operacoes, sum(op.qtd) pecas,
            sum(oo.minutos) minutos_reais, sum(oo.tempo_unit_min*op.qtd) minutos_padrao,
            sum(case when oo.minutos>=1 and oo.sem_registro=0 then oo.tempo_unit_min*op.qtd else 0 end) padrao_medido,
            sum(case when oo.minutos>=1 and oo.sem_registro=0 then oo.minutos else 0 end) minutos_medidos, sum(oo.sem_registro=1) sem_registro
          from op_operacao oo join op on op.id=oo.op_id join operacao_tipo t on t.id=oo.operacao_tipo_id
          join funcionario f on f.id=oo.funcionario_id left join setor s on s.id=f.setor_id
          where oo.status='finalizado' and t.espera=0 and oo.fim between ? and ? group by f.id order by s.id, f.nome`, de, ate);
        const detalhe = await all(DB, `select oo.fim, f.nome funcionario, t.nome operacao, op.codigo, i.nome item, op.qtd, oo.minutos, oo.sem_registro, oo.tempo_unit_min*op.qtd padrao
          from op_operacao oo join op on op.id=oo.op_id join operacao_tipo t on t.id=oo.operacao_tipo_id join item i on i.id=op.item_id
          left join funcionario f on f.id=oo.funcionario_id
          where oo.status='finalizado' and t.espera=0 and oo.fim between ? and ? order by oo.fim desc limit 300`, de, ate);
        const finalizadas = await all(DB, `select op.codigo, i.nome item, op.qtd, op.finalizado_em from op join item i on i.id=op.item_id
          where op.status='finalizada' and op.finalizado_em between ? and ? order by op.finalizado_em desc`, de, ate);
        return json(req, { porPessoa, detalhe, finalizadas });
      }

      return json(req, { erro: 'Rota não encontrada' }, 404);
    } catch (e) {
      return json(req, { erro: e.message }, 400);
    }
  },
};
export default app;
