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
      st.push(DB.prepare('insert into pedido(numero, cliente, prazo, data_pagamento, status, obs, tipo) values(?,?,?,?,?,?,?)').bind(num, cliente, prazo, pag, stt || 'Em produção', pv.tipo ? 'Tipo: ' + pv.tipo : null, tipoPedido(pv.tipo)));
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
// lançamentos a receber de um pedido (ligados pelo pedido_id, pela descrição "Pedido N…" ou pela NF de um envio do pedido)
async function finDoPedido(DB, ped) {
  const n = String(ped.numero);
  const lancs = await all(DB, `select l.id, l.descricao, l.pessoa, l.vencimento, l.quitacao, l.parcela, l.nf, l.valor, l.pago, l.status, round(l.valor-l.pago,2) aberto,
      (l.status='aberto' and l.vencimento < date('now','-4 hours')) vencido from fin_lancamento l
    where l.tipo='R' and l.status!='cancelado' and (l.pedido_id=? or l.descricao like 'Pedido ' || ? || ' %' or l.descricao = 'Pedido ' || ? or l.descricao like 'Pedido ' || ? || '-%'
      or (l.nf is not null and l.nf in (select e.nf from envio e where e.pedido_id=? and e.nf is not null))) order by l.vencimento`, ped.id, n, n, n, ped.id);
  const s = k => Math.round(lancs.reduce((a, l) => a + (k(l) || 0), 0) * 100) / 100;
  return { lancs, total: s(l => l.valor), pago: s(l => l.pago), aberto: s(l => l.status === 'aberto' ? l.aberto : 0), vencido: s(l => l.vencido ? l.aberto : 0) };
}
// clientes e dados fiscais (v21): criados sozinhos na primeira chamada; alter ignora se já existe
let basePronta = false;
const BASE_DDL = ["create table if not exists cliente (id integer primary key, sensio_id text unique, nome text not null, razao text, doc text, natureza text, ie text, email text, telefone text, endereco text, numero text, complemento text, bairro text, cep text, cidade text, uf text, vendedor text, ativo int not null default 1, criado_em text default (datetime('now')))", "create index if not exists cliente_nome on cliente(nome)", "alter table pedido add column cliente_id int", "alter table item add column ncm text", "alter table item add column origem int", "alter table item add column unidade text", "alter table item add column peso_liquido real", "alter table item add column peso_bruto real", "create table if not exists transferencia (id integer primary key, data text not null, de_id int not null, para_id int not null, documento text, transportadora text, obs text, criado_em text default (datetime('now')), criado_por int, criado_nome text)", "create table if not exists transferencia_item (transferencia_id int not null, item_id int not null, qtd real not null)", "update item set codigo='PROD01001' where codigo='PROD-EXPO-0068'", "update item set codigo='PROD01002' where codigo='PROD-EXPO-0085'", "update item set codigo='PROD01003' where codigo='PROD-EXPO-0088'", "update item set codigo='PROD01004' where codigo='PROD-EXPO-0091'", "update item set codigo='PROD01005' where codigo='PROD-EXPO-0092'", "update item set codigo='PROD01006' where codigo='PROD-EXPO-0093'", "update item set codigo='PROD01007' where codigo='PROD-EXPO-0186'", "update item set codigo='PROD01008' where codigo='PROD-EXPO-0187'", "update item set codigo='PROD01009' where codigo='PROD-EXPO-0188'", "update item set codigo='PROD01010' where codigo='PROD-EXPO-0189'", "update item set codigo='PROD01011' where codigo='PROD-EXPO-0190'", "update item set codigo='PROD01012' where codigo='PROD-EXPO-0191'", "update item set codigo='PROD01013' where codigo='PROD-EXPO-0192'", "update item set codigo='PROD01014' where codigo='PROD-EXPO-0193'", "update item set codigo='PROD01015' where codigo='PROD-EXPO-0194'", "update item set codigo='PROD01016' where codigo='PROD-EXPO-0195'", "update item set codigo='PROD01017' where codigo='PROD-EXPO-0196'", "update item set codigo='PROD01018' where codigo='PROD-EXPO-0197'", "update item set codigo='PROD01019' where codigo='PROD-EXPO-0198'", "update item set codigo='PROD01020' where codigo='PROD-EXPO-0199'", "update item set codigo='PROD01021' where codigo='PROD-EXPO-0200'", "update item set codigo='PROD01022' where codigo='PROD-EXPO-0201'", "update item set ativo=0 where codigo='PROD0068' and not exists (select 1 from estoque_mov m where m.item_id=item.id)", "alter table op_evento add column usuario_nome text", "alter table estoque_mov add column usuario_nome text", "alter table item add column produz int not null default 1", "alter table item add column estoque_min real", "create table if not exists migracao (nome text primary key)", "update item set produz=0 where tipo='Produto' and (lower(nome) like '%cloche%' or lower(nome) like 'caixa%' or lower(nome) like 'vaso tulipa p %' or lower(nome) like '% mini %' or lower(nome) like 'mini %' or lower(nome) like 'talher%') and not exists (select 1 from migracao where nome='produz1')", "insert or ignore into migracao values('produz1')", "insert into composicao(item_id, insumo_id, qtd) select e.id, c.insumo_id, c.qtd from item e join item k on k.madeira=e.madeira and k.nome like 'Canopique Vessel G %' and k.nome not like '%Mini%' join composicao c on c.item_id=k.id where e.nome like 'Eixo G %' and not exists (select 1 from composicao x where x.item_id=e.id) and not exists (select 1 from migracao where nome='comp1')", "insert into composicao(item_id, insumo_id, qtd) select e.id, c.insumo_id, c.qtd from item e join item k on k.madeira=e.madeira and k.nome like 'Canopique Vessel M %' and k.nome not like '%Mini%' join composicao c on c.item_id=k.id where e.nome like 'Eixo M %' and not exists (select 1 from composicao x where x.item_id=e.id) and not exists (select 1 from migracao where nome='comp1')", "insert into composicao(item_id, insumo_id, qtd) select e.id, c.insumo_id, c.qtd from item e join item k on k.madeira=e.madeira and k.nome like 'Tigela Patauá %' and k.nome not like '%Mini%' join composicao c on c.item_id=k.id where e.nome like 'Buriti %' and not exists (select 1 from composicao x where x.item_id=e.id) and not exists (select 1 from migracao where nome='comp1')", "insert or ignore into migracao values('comp1')", "alter table pedido add column tipo text not null default 'cliente'", "alter table peca_qualidade add column resultado text", "alter table foto add column envio_id int", "create index if not exists foto_envio on foto(envio_id)", "create table if not exists hist_op (codigo int primary key, sensio_id text, item_codigo text, item_nome text, qtd real, status text, estagio text, criado_em text, inicio text, finalizado_em text, obs text, pedido_numero text, retrabalho int, origem text not null default 'sensio')", "create index if not exists hist_op_fim on hist_op(finalizado_em)", "create table if not exists hist_op_etapa (sensio_id text primary key, op_codigo int not null, ordem int, operacao text, status text, inicio text, fim text, duracao_seg real, qtd_produzida real, operadores text, recurso text, origem text not null default 'sensio')", "create index if not exists hist_etapa_op on hist_op_etapa(op_codigo)", "create table if not exists hist_op_evento (sensio_id text primary key, op_codigo int not null, data text, de text, para text, usuario text, origem text not null default 'sensio')", "create index if not exists hist_ev_op on hist_op_evento(op_codigo)", "create table if not exists hist_estoque_mov (sensio_id text primary key, data text not null, item_codigo text, item_nome text, item_tipo text, deposito text, deposito_id int, tipo text, qtd real, documento text, cancelado int, usuario text, origem text not null default 'sensio')", "create index if not exists hist_mov_data on hist_estoque_mov(data)", "create table if not exists hist_venda (sensio_id text primary key, codigo int, tipo_sensio text, tipo text, status text, cliente text, data_venda text, criado_em text, total real, pago int, data_pagamento text, data_faturamento text, origem text not null default 'sensio')", "create index if not exists hist_venda_cod on hist_venda(codigo)", "create table if not exists hist_nfe (sensio_id text primary key, numero text, data text, status text, valor real, cliente text, venda_sensio_id text, venda_codigo int, origem text not null default 'sensio')", "create index if not exists hist_nfe_venda on hist_nfe(venda_codigo)", "alter table pedido add column data_faturamento text"];
// financeiro: tabelas criadas sozinhas na primeira chamada (schema_v18.sql + v19)
let finPronto = false;
const FIN_DDL = ["create table if not exists fin_conta (id integer primary key, nome text not null unique, tipo text, saldo_inicial real not null default 0, ativo int not null default 1)", "create table if not exists fin_categoria (id integer primary key, nome text not null, tipo text not null, grupo_dre text, plano text, ativo int not null default 1, unique(nome, tipo))", "create table if not exists fin_centro (id integer primary key, nome text not null unique, ativo int not null default 1)", "create table if not exists fin_lancamento ( id integer primary key, tipo text not null, descricao text not null, obs text, pessoa text, conta_id int, conta_destino_id int, categoria_id int, centro_id int, metodo text, valor real not null, pago real not null default 0, vencimento text not null, competencia text, quitacao text, parcela text, nf text, pedido_id int, status text not null default 'aberto', origem text not null default 'manual', sensio_id text unique, criado_em text default (datetime('now')), criado_por int)", "create index if not exists fin_l_venc on fin_lancamento(vencimento)", "create index if not exists fin_l_quit on fin_lancamento(quitacao)", "create index if not exists fin_l_comp on fin_lancamento(competencia)", "create index if not exists fin_l_status on fin_lancamento(status)", "create table if not exists fin_cobranca (id integer primary key, pessoa text not null, lancamento_id int, tipo text not null, texto text, promessa_data text, criado_em text default (datetime('now')), criado_por int, criado_nome text)", "create index if not exists fin_cob_pessoa on fin_cobranca(pessoa)", "create table if not exists fin_anexo (id integer primary key, lancamento_id int not null, nome text, tipo text not null, dados text not null, criado_em text default (datetime('now')), criado_por int, criado_nome text)", "create index if not exists fin_anexo_l on fin_anexo(lancamento_id)", "create table if not exists fin_extrato (id integer primary key, conta_id int not null, fitid text not null, data text not null, valor real not null, descricao text, lancamento_id int, status text not null default 'pendente', criado_em text default (datetime('now')), unique(conta_id, fitid))"];
// colunas novas (v20): roda uma por uma e ignora se já existe
const FIN_ALTER = ["alter table fin_lancamento add column aprovado int not null default 1", "alter table fin_conta add column extrato_saldo real", "alter table fin_conta add column extrato_data text"];
// metas por funcionário: grupo da etapa e chave da peça (família + tamanho)
const GRUPOS_META = [['TA', 'Torno Fase A'], ['TB', 'Torno Fase B'], ['AC', 'Acabamento'], ['MA', 'Marcenaria A'], ['MB', 'Marcenaria B']];
const NOME_GRUPO = Object.fromEntries(GRUPOS_META);
const CHAVES_META = ['canopique xg', 'canopique g', 'canopique m', 'pilao g', 'pilao m', 'tulipa g', 'tulipa m', 'sussurro xg', 'sussurro g', 'sussurro m', 'iracema xg', 'iracema g', 'iracema m', 'pataua', 'floresta', 'tucupi', 'frondosa', 'serenata', 'jaci', 'curio', 'bem-te-vi', 'juriti', 'carcara', 'tangara'];
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// histórico do Sensio (somente leitura; tabelas hist_* nunca entram no saldo)
const DEP_SENSIO = { 'P.A.': 1, 'Showroom OMAMA': 3, 'Pátio': 11, 'Defeito': 6 };
const manaus = s => s ? `datetime(${s},'-4 hours')` : null;
const HIST_COLS = {
  op: ['codigo', 'sensio_id', 'item_codigo', 'item_nome', 'qtd', 'status', 'estagio', 'criado_em', 'inicio', 'finalizado_em', 'obs', 'pedido_numero', 'retrabalho'],
  etapa: ['sensio_id', 'op_codigo', 'ordem', 'operacao', 'status', 'inicio', 'fim', 'duracao_seg', 'qtd_produzida', 'operadores', 'recurso'],
  evento: ['sensio_id', 'op_codigo', 'data', 'de', 'para', 'usuario'],
  mov: ['sensio_id', 'data', 'item_codigo', 'item_nome', 'item_tipo', 'deposito', 'deposito_id', 'tipo', 'qtd', 'documento', 'cancelado', 'usuario'],
  venda: ['sensio_id', 'codigo', 'tipo_sensio', 'tipo', 'status', 'cliente', 'data_venda', 'criado_em', 'total', 'pago'],
  nfe: ['sensio_id', 'numero', 'data', 'status', 'valor', 'cliente', 'venda_sensio_id', 'venda_codigo'],
};
const HIST_TAB = { op: 'hist_op', etapa: 'hist_op_etapa', evento: 'hist_op_evento', mov: 'hist_estoque_mov', venda: 'hist_venda', nfe: 'hist_nfe' };
const TIPOS_PEDIDO = ['cliente', 'troca', 'reposicao', 'showroom', 'brinde', 'consignado'];
const tipoPedido = s => { const t = semAcento(s); return TIPOS_PEDIDO.find(x => x !== 'cliente' && t.includes(x.slice(0, 6))) || 'cliente'; };
const grupoMeta = tipo => ({ 'torno fase a': 'TA', 'torno fase b': 'TB', 'acabamento': 'AC', 'finalizacao': 'AC', 'marcenaria a': 'MA', 'marcenaria b': 'MB' })[semAcento(tipo)] || null;
function chaveMeta(nome) {
  const w = semAcento(nome).split(/\s+/).map(x => ({ eixo: 'canopique', buriti: 'pataua' })[x] || x); // Eixo = Canopique, Buriti = Patauá (decisão do Emanuel 24/11)
  const fam = ['canopique', 'pilao', 'tulipa', 'sussurro', 'iracema', 'pataua', 'floresta', 'tucupi', 'frondosa', 'serenata', 'jaci', 'curio', 'bem-te-vi', 'juriti', 'carcara', 'tangara'].find(f => w.includes(f));
  if (!fam) return null;
  if (['canopique', 'pilao', 'tulipa', 'sussurro', 'iracema'].includes(fam)) { const t = w.slice(w.indexOf(fam) + 1).find(x => ['xg', 'g', 'm'].includes(x)); return t ? fam + ' ' + t : null; }
  return fam;
}
const nomeChave = c => c.replace('pilao', 'Pilão').replace('pataua', 'Patauá').replace('curio', 'Curió').replace('carcara', 'Carcará').replace('tangara', 'Tangará').replace(/(^|\s)([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(' Xg', ' XG');
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
// limite de usuários: conta todos os ativos menos o administrador principal (o primeiro criado)
const USADOS = 'select count(*) n from usuario where ativo=1 and id != (select min(id) from usuario where admin=1)';
const loginOk = l => /^[a-z0-9._-]{3,30}$/.test(l);
// permissões: quais telas o usuário usa. Leitura é livre (as telas compartilham dados); gravar e ver dados de pessoas pede a tela.
const TELAS = ['painel', 'fila', 'ops', 'ped', 'exp', 'pcp', 'estoque', 'ent', 'inv', 'defeitos', 'itens', 'func', 'assid', 'rel', 'efic', 'qual', 'sem', 'fin'];
const PERM = [
  [/^\/api\/presenca/, null, ['assid', 'sem']], [/^\/api\/relatorio/, null, ['rel', 'sem']], [/^\/api\/eficiencia/, null, ['efic', 'rel', 'painel']], [/^\/api\/metas/, 'POST', ['efic']], [/^\/api\/semana/, null, ['sem']], [/^\/api\/painel/, null, ['painel']],
  [/^\/api\/operacoes\//, 'POST', ['fila', 'ops']], [/^\/api\/ops/, 'POST', ['ops', 'ped', 'pcp']],
  [/^\/api\/pedidos\/[^/]+\/envio/, 'POST', ['exp']], [/^\/api\/pedido-itens\/\d+\/exp/, 'POST', ['exp']], [/^\/api\/pedidos/, 'POST', ['ped']], [/^\/api\/clientes/, 'POST', ['ped', 'fin']], [/^\/api\/itens\/\d+\/fiscal/, 'POST', ['itens']],
  [/^\/api\/pcp/, 'POST', ['pcp']], [/^\/api\/estoque\/mov/, 'POST', ['estoque']], [/^\/api\/estoque\/transferir/, 'POST', ['estoque', 'exp']], [/^\/api\/insumos/, 'POST', ['estoque']], [/^\/api\/entradas/, 'POST', ['ent']], [/^\/api\/inventarios/, 'POST', ['inv']],
  [/^\/api\/defeitos/, 'POST', ['defeitos', 'ops']], [/^\/api\/rt/, 'POST', ['ops', 'defeitos']], [/^\/api\/qualidade/, 'POST', ['qual']], [/^\/api\/itens/, 'POST', ['itens']], [/^\/api\/funcionarios/, 'POST', ['func']], [/^\/api\/fotos/, 'POST', ['ops', 'defeitos', 'qual', 'ped', 'exp']],
  [/^\/api\/sync\//, 'POST', ['admin']], [/^\/api\/fin\//, null, ['fin']],
];
// grava quem lançou: todo insert em op_evento / estoque_mov ganha usuario_nome do login da requisição
const comQuem = (db, u) => { const nome = u.nome || u.login || 'Sistema';
  return new Proxy(db, { get(t, k) {
    if (k === 'prepare') return sql => { const x = /^insert into (op_evento|estoque_mov)\(([^)]*)\) values\(([^)]*)\)$/.exec(sql); if (!x) return t.prepare(sql);
      const s2 = `insert into ${x[1]}(${x[2]}, usuario_nome) values(${x[3]}, ?)`; return { bind: (...a) => t.prepare(s2).bind(...a, nome) }; };
    const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } }); };
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
  { name: 'pedidos_abertos', description: 'Lista os pedidos em aberto com prazo, status, tipo (cliente, troca, reposicao, showroom, brinde, consignado; prazo e lead time só valem para cliente) e quantas peças têm OP, estão conferidas, embaladas e enviadas.', inputSchema: { type: 'object', properties: {} }, path: () => '/api/pedidos' },
  { name: 'pedido', description: 'Detalhe de um pedido OMAMA pelo número: peças, OPs ligadas (estágio), conferidas/embaladas/enviadas, envios, tipo, data de pagamento e de faturamento. historico_sensio = a venda no Sensio (tipo, status, cliente, data da venda, total, pago, data_pagamento, data_faturamento, NFs e saídas de estoque); pedidos antigos que só existem no Sensio também são encontrados.', inputSchema: { type: 'object', properties: { numero: { type: 'string' } }, required: ['numero'] }, path: a => '/api/pedidos/' + encodeURIComponent(a.numero) },
  { name: 'ops_abertas', description: 'Lista as OPs abertas com item, quantidade, estágio, previsão de entrega, pedido e operação atual.', inputSchema: { type: 'object', properties: {} }, path: () => '/api/ops' },
  { name: 'estoque', description: 'Saldo de estoque de um depósito. deposito_id: 1 = P.A. Manaus (produto acabado na fábrica), 3 = P.A. São Paulo, 11 = Pátio (blocos de madeira), 6 = Defeito, 2 = Insumos.', inputSchema: { type: 'object', properties: { deposito_id: { type: 'number' } }, required: ['deposito_id'] }, path: a => '/api/estoque?deposito_id=' + Number(a.deposito_id) },
  { name: 'producao_periodo', description: 'Produção e eficiência por pessoa num período (datas AAAA-MM-DD).', inputSchema: { type: 'object', properties: { de: { type: 'string' }, ate: { type: 'string' } }, required: ['de', 'ate'] }, path: a => `/api/relatorio?de=${a.de}&ate=${a.ate}` },
  { name: 'defeitos', description: 'Peças que estão no estoque de defeito agora (item, quantidade, motivo, OP, setor).', inputSchema: { type: 'object', properties: {} }, path: () => '/api/defeitos' },
  { name: 'faltas_semana', description: 'Faltas, atestados, atrasos e folgas lançados num período (datas AAAA-MM-DD).', inputSchema: { type: 'object', properties: { de: { type: 'string' }, ate: { type: 'string' } }, required: ['de', 'ate'] }, path: a => `/api/presenca?de=${a.de}&ate=${a.ate}` },
  { name: 'historico_sensio_resumo', description: 'Conferência do histórico importado do Sensio: totais por tabela e, semana a semana (segunda a domingo, horário de Manaus), OPs finalizadas e entradas no P.A. vindas de OP.', inputSchema: { type: 'object', properties: {} }, path: () => '/api/hist/resumo' },
  { name: 'pcp_sugestao', description: 'Sugestão do PCP: peças de pedidos que ainda precisam de OP, quantas dá para fazer com o bloco do Pátio e quanta madeira falta.', inputSchema: { type: 'object', properties: {} }, path: () => '/api/pcp/sugestao' },
  { name: 'producao_semana', description: 'Produção da semana (datas AAAA-MM-DD): OPs finalizadas (código, qtd, peça, pedido, tipo_pedido), OPs criadas, envios de pedidos (envio_id, data, pedido, cliente, tipo_pedido, transportadora, peças, fotos = nº de fotos do envio/coleta, tem_foto 0/1), entradas de madeira e inventários fechados. historico_sensio = o mesmo período no Sensio (OPs finalizadas, faturamento por NF autorizada e entradas no P.A. vindas de OP), só para o que não existe no sistema novo. tipo_pedido: cliente, troca, reposicao, showroom, brinde ou consignado.', inputSchema: { type: 'object', properties: { de: { type: 'string' }, ate: { type: 'string' } }, required: ['de', 'ate'] }, path: a => `/api/semana?de=${encodeURIComponent(a.de || '')}&ate=${encodeURIComponent(a.ate || '')}` },
  { name: 'qualidade_cq', description: 'Controle de qualidade por OP finalizada nos últimos N dias (padrão 60, máx 365): peça, pedido, nº de peças, quantas classificadas, as classes em ordem (ex.: "AAB") e pecas_cq = cada peça com numero, classe A/B/C/D, resultado (aprovada, reprovada, retrabalho ou null se não informado), obs e data_cq (UTC).', inputSchema: { type: 'object', properties: { dias: { type: 'number' } } }, path: a => `/api/qualidade?dias=${Number(a.dias) || 60}` },
  { name: 'fotos_pedido', description: 'Lista das fotos de um pedido (das OPs, das peças do pedido e dos envios/coletas, estas com codigo = ENVIO): id, nome do arquivo, data, código e nome da peça, OP. Só a lista, sem a imagem.', inputSchema: { type: 'object', properties: { pedido: { type: 'string' } }, required: ['pedido'] }, path: a => `/api/fotos?pedido=${encodeURIComponent(a.pedido || '')}` },
  { name: 'movimentacoes_estoque', description: 'Movimentações de estoque (data UTC e data_manaus, peça, depósito, quantidade, motivo, OP e quem lançou), da mais nova pra mais antiga. Filtros opcionais: de e ate (AAAA-MM-DD, dia de Manaus) e deposito_id (1 = P.A. Manaus, 3 = P.A. São Paulo, 11 = Pátio, 6 = Defeito, 2 = Insumos). Sem nenhum filtro traz só as 100 últimas do sistema; com filtro, até 20.000, juntando o sistema (origem = sistema) e o histórico do Sensio desde 24/02/2025 (origem = sensio; não entra no saldo; cancelado = 1 quando foi cancelada no Sensio). Depósitos do Sensio sem id (Provisório, Retrabalho, Brinde, Consignado, Análise, Modelo, Teste) filtram por deposito_nome. origem = sistema traz só o sistema novo.', inputSchema: { type: 'object', properties: { de: { type: 'string' }, ate: { type: 'string' }, deposito_id: { type: 'number' }, deposito_nome: { type: 'string' }, origem: { type: 'string' } } }, path: a => `/api/estoque/movs?de=${encodeURIComponent(a.de || '')}&ate=${encodeURIComponent(a.ate || '')}&deposito_id=${Number(a.deposito_id) || ''}&deposito_nome=${encodeURIComponent(a.deposito_nome || '')}&origem=${encodeURIComponent(a.origem || '')}` },
  { name: 'op_detalhe', description: 'Detalhe de uma OP pelo número (ex.: 5012): peça, estágio, etapas do roteiro com quem fez, início, fim e tempo, pausas, blocos usados e os eventos com data e hora. OPs antigas do Sensio (ou com passado no Sensio) vêm em historico_sensio: etapas (operação, status, início, fim, duração, operadores) e eventos de estágio; horários em UTC.', inputSchema: { type: 'object', properties: { codigo: { type: 'number' } }, required: ['codigo'] }, path: a => `/api/ops/${Number(a.codigo) || 0}` },
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
    const DB = comQuem(env.DB, usuario);
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    let m;
    if (!basePronta) { for (const s of BASE_DDL) await DB.prepare(s).run().catch(() => {}); basePronta = true; }
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
        return json(req, { max: MAX_USUARIOS, usados: (await one(DB, USADOS)).n, eu: usuario.id, telas: TELAS, lista: (await all(DB, `select id, login, nome, admin, ativo, criado_em, permissoes,
          (select max(criado_em) from sessao where usuario_id=usuario.id) ultimo_acesso from usuario order by admin desc, ativo desc, nome`)).map(u => ({ ...u, permissoes: u.admin ? TELAS : lePerm(u.permissoes) })) });
      }
      if (p === '/api/usuarios' && req.method === 'POST') {
        const login = String(body.login || '').trim().toLowerCase();
        if (!loginOk(login)) return json(req, { erro: 'Usuário: de 3 a 30 letras minúsculas, números, ponto ou traço (sem espaço)' }, 400);
        if (String(body.senha || '').length < 6) return json(req, { erro: 'A senha precisa de pelo menos 6 caracteres' }, 400);
        if ((await one(DB, USADOS)).n >= MAX_USUARIOS) return json(req, { erro: `Já tem ${MAX_USUARIOS} usuários ativos (o máximo). Desative um antes.` }, 400);
        if (await one(DB, 'select id from usuario where login=?', login)) return json(req, { erro: 'Esse usuário já existe' }, 400);
        const salt = crypto.randomUUID();
        await DB.prepare('insert into usuario(login, nome, senha_hash, salt, admin, permissoes) values(?,?,?,?,0,?)').bind(login, String(body.nome || '').trim() || login, await hashSenha(String(body.senha), salt), salt, JSON.stringify(Array.isArray(body.permissoes) ? lePerm(JSON.stringify(body.permissoes)) : TELAS.filter(t => t !== 'fin'))).run();
        if (body.admin) await DB.prepare('update usuario set admin=1 where login=?').bind(login).run();
        return json(req, { ok: true });
      }
      if ((m = p.match(/^\/api\/usuarios\/(\d+)$/)) && req.method === 'POST') {
        const u = await one(DB, 'select * from usuario where id=?', Number(m[1]));
        if (!u) return json(req, { erro: 'Usuário não encontrado' }, 404);
        const ativo = body.ativo === undefined ? u.ativo : (body.ativo ? 1 : 0), admin = body.admin === undefined ? u.admin : (body.admin ? 1 : 0);
        if ((!ativo || !admin) && u.id === (await one(DB, 'select min(id) id from usuario where admin=1')).id && u.id !== usuario.id) return json(req, { erro: 'O administrador principal não pode ser desativado nem perder o acesso de administrador' }, 400);
        if (u.id === usuario.id && (!ativo || !admin)) return json(req, { erro: 'Você não pode tirar o seu próprio acesso de administrador nem se desativar' }, 400);
        if (u.admin && u.ativo && (!ativo || !admin) && (await one(DB, 'select count(*) n from usuario where admin=1 and ativo=1')).n <= 1) return json(req, { erro: 'Precisa ficar pelo menos um administrador ativo' }, 400);
        if (ativo && !u.ativo && (await one(DB, USADOS)).n >= MAX_USUARIOS) return json(req, { erro: `Já tem ${MAX_USUARIOS} usuários ativos (o máximo)` }, 400);
        const st = [DB.prepare('update usuario set admin=? where id=?').bind(admin, u.id), DB.prepare('update usuario set nome=?, ativo=?, permissoes=? where id=?').bind(body.nome === undefined ? u.nome : (String(body.nome).trim() || u.nome), ativo, Array.isArray(body.permissoes) ? JSON.stringify(lePerm(JSON.stringify(body.permissoes))) : u.permissoes, u.id)];
        if (body.senha) {
          if (String(body.senha).length < 6) return json(req, { erro: 'A senha precisa de pelo menos 6 caracteres' }, 400);
          const salt = crypto.randomUUID();
          st.push(DB.prepare('update usuario set senha_hash=?, salt=? where id=?').bind(await hashSenha(String(body.senha), salt), salt, u.id));
        }
        if (body.senha || !ativo) st.push(DB.prepare('delete from sessao where usuario_id=?').bind(u.id));
        await DB.batch(st);
        return json(req, { ok: true });
      }

      // ---------- clientes (cadastro pra nota fiscal; trazidos do Sensio) e dados fiscais dos itens
      if (p === '/api/clientes' && req.method === 'GET') {
        const s = '%' + (q('q') || '').trim() + '%', d = (q('q') || '').replace(/\D/g, '');
        return json(req, await all(DB, `select * from cliente where ativo=1 and (nome like ? or razao like ? ${d.length >= 3 ? "or replace(replace(replace(doc,'.',''),'-',''),'/','') like ?" : ''}) order by nome limit 60`, s, s, ...(d.length >= 3 ? ['%' + d + '%'] : [])));
      }
      if ((m = p.match(/^\/api\/clientes\/(\d+)$/)) && req.method === 'GET') {
        const c = await one(DB, 'select * from cliente where id=?', Number(m[1]));
        return c ? json(req, c) : json(req, { erro: 'Cliente não encontrado' }, 404);
      }
      if (p === '/api/clientes' && req.method === 'POST') {
        const f = ['nome', 'razao', 'doc', 'natureza', 'ie', 'email', 'telefone', 'endereco', 'numero', 'complemento', 'bairro', 'cep', 'cidade', 'uf'];
        const v = Object.fromEntries(f.map(k => [k, String(body[k] ?? '').trim() || null]));
        if (!v.nome) return json(req, { erro: 'Coloque o nome do cliente' }, 400);
        if (v.uf) v.uf = v.uf.toUpperCase().slice(0, 2);
        if (Number(body.id)) { await DB.prepare(`update cliente set ${f.map(k => k + '=?').join(', ')} where id=?`).bind(...f.map(k => v[k]), Number(body.id)).run(); return json(req, { ok: true, id: Number(body.id) }); }
        const r = await DB.prepare(`insert into cliente(${f.join(', ')}) values(${f.map(() => '?').join(',')})`).bind(...f.map(k => v[k])).run();
        return json(req, { ok: true, id: r.meta.last_row_id });
      }
      if (p === '/api/clientes/importar' && req.method === 'POST') {
        if (!usuario.admin) return json(req, { erro: 'Só o administrador' }, 403);
        const L = Array.isArray(body.clientes) ? body.clientes : [];
        await DB.batch(L.map(c => DB.prepare(`insert into cliente(sensio_id, nome, razao, doc, natureza, ie, email, telefone, endereco, numero, complemento, bairro, cep, cidade, uf, vendedor)
          values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(sensio_id) do update set nome=excluded.nome, razao=excluded.razao, doc=excluded.doc, natureza=excluded.natureza, ie=excluded.ie, email=excluded.email,
          telefone=excluded.telefone, endereco=excluded.endereco, numero=excluded.numero, complemento=excluded.complemento, bairro=excluded.bairro, cep=excluded.cep, cidade=excluded.cidade, uf=excluded.uf, vendedor=excluded.vendedor`)
          .bind(String(c.sensio_id), c.nome || '(sem nome)', c.razao || null, c.doc || null, c.natureza || null, c.ie || null, c.email || null, c.telefone || null, c.endereco || null, c.numero || null, c.complemento || null, c.bairro || null, c.cep || null, c.cidade || null, c.uf || null, c.vendedor || null)));
        return json(req, { ok: true, n: L.length });
      }
      if ((m = p.match(/^\/api\/pedidos\/([^/]+)\/cliente$/)) && req.method === 'POST') {
        const r = await DB.prepare('update pedido set cliente_id=? where numero=?').bind(Number(body.cliente_id) || null, decodeURIComponent(m[1])).run();
        return json(req, { ok: true });
      }
      if (p === '/api/itens/fiscal/importar' && req.method === 'POST') {
        if (!usuario.admin) return json(req, { erro: 'Só o administrador' }, 403);
        const L = Array.isArray(body.itens) ? body.itens : [];
        await DB.batch(L.map(x => DB.prepare('update item set ncm=coalesce(?, ncm), origem=coalesce(?, origem), unidade=coalesce(?, unidade), peso_liquido=coalesce(?, peso_liquido), peso_bruto=coalesce(?, peso_bruto) where codigo=?')
          .bind(x.ncm || null, x.origem ?? null, x.unidade || null, Number(x.peso_liquido) || null, Number(x.peso_bruto) || null, x.codigo)));
        return json(req, { ok: true, n: L.length });
      }
      if ((m = p.match(/^\/api\/itens\/(\d+)\/fiscal$/)) && req.method === 'POST') {
        const ncm = String(body.ncm || '').replace(/\D/g, '');
        if (ncm && ncm.length !== 8) return json(req, { erro: 'NCM tem 8 números (ex.: 44192000)' }, 400);
        await DB.prepare('update item set ncm=?, origem=? where id=?').bind(ncm || null, body.origem === '' || body.origem === undefined ? null : Number(body.origem), Number(m[1])).run();
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
        const histOp = async c => { const h = await one(DB, 'select * from hist_op where codigo=?', c); if (!h) return null;
          const [etapas, eventos] = await Promise.all([all(DB, 'select ordem, operacao, status, inicio, fim, duracao_seg, qtd_produzida, operadores, recurso from hist_op_etapa where op_codigo=? order by ordem, inicio', c),
            all(DB, 'select data, de, para, usuario from hist_op_evento where op_codigo=? order by data', c)]); return { ...h, etapas, eventos }; };
        if (!op) { const h = await histOp(Number(m[1])); if (h) return json(req, { codigo: h.codigo, origem: 'sensio', status: h.status, historico_sensio: h }); }
        if (!op) return json(req, { erro: 'OP não encontrada' }, 404);
        const [operacoes, eventos, materiais] = await Promise.all([
          all(DB, `select oo.*, t.nome, t.setor_id, t.espera, t.estagio_id, f.nome funcionario, (select x.motivo || coalesce(' – ' || x.obs, '') from op_pausa x where x.op_operacao_id=oo.id and x.fim is null order by x.id desc limit 1) pausa_motivo from op_operacao oo
            join operacao_tipo t on t.id=oo.operacao_tipo_id left join funcionario f on f.id=oo.funcionario_id where oo.op_id=? order by oo.ordem`, op.id),
          all(DB, 'select * from op_evento where op_id=? order by id desc', op.id),
          all(DB, `select i.codigo, i.nome, c.qtd, c.qtd*? total,
            coalesce((select sum(qtd) from estoque_mov where item_id=i.id and deposito_id=?),0) saldo_patio
            from composicao c join item i on i.id=c.insumo_id where c.item_id=?`, op.qtd, DEP_PATIO, op.item_id),
        ]);
        return json(req, { ...op, operacoes, eventos, materiais, historico_sensio: await histOp(op.codigo) });
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
      // ---------- histórico do Sensio: importação (admin) e resumo
      if (p === '/api/hist/importar' && req.method === 'POST') {
        if (!usuario.admin) return json(req, { erro: 'Só administrador' }, 403);
        const t = body.tipo, cols = HIST_COLS[t], tab = HIST_TAB[t]; if (!cols) return json(req, { erro: 'tipo inválido' }, 400);
        if (body.limpar) await DB.prepare(`delete from ${tab}`).run();
        const linhas = body.linhas || [], sql = `insert or replace into ${tab}(${cols.join(',')}) values(${cols.map(() => '?').join(',')})`;
        for (let i = 0; i < linhas.length; i += 80) await DB.batch(linhas.slice(i, i + 80).map(l => DB.prepare(sql).bind(...cols.map(c => l[c] === undefined ? null : l[c]))));
        if (t === 'nfe' || t === 'venda') {
          // data de faturamento = primeira NF autorizada da venda; data de pagamento = última quitação, quando o pedido está todo pago no financeiro
          await DB.batch([
            DB.prepare(`update hist_venda set data_faturamento=(select min(n.data) from hist_nfe n where n.venda_sensio_id=hist_venda.sensio_id and n.status='Autorizada')`),
            DB.prepare(`update pedido set data_faturamento=(select v.data_faturamento from hist_venda v where cast(v.codigo as text)=pedido.numero) where data_faturamento is null`),
            DB.prepare(`update pedido set tipo=(select v.tipo from hist_venda v where cast(v.codigo as text)=pedido.numero and v.tipo is not null) where tipo='cliente' and exists (select 1 from hist_venda v where cast(v.codigo as text)=pedido.numero and v.tipo is not null and v.tipo<>'cliente')`)]);
          await DB.batch([
            DB.prepare(`with lv as (select v.sensio_id, l.status, l.quitacao from hist_venda v join fin_lancamento l on l.tipo='R' and l.status!='cancelado' and (
                  l.descricao like 'Pedido ' || v.codigo || ' %' or l.descricao = 'Pedido ' || v.codigo or l.descricao like 'Pedido ' || v.codigo || '-%'
                  or exists (select 1 from hist_nfe n where n.venda_sensio_id=v.sensio_id and n.status='Autorizada' and (l.nf=n.numero or l.descricao like 'NF' || n.numero || '-%' or l.descricao = 'NF' || n.numero or l.descricao like 'NF ' || n.numero || '%'))))
              update hist_venda set data_pagamento=(select max(quitacao) from lv where lv.sensio_id=hist_venda.sensio_id and lv.status='quitado')
              where not exists (select 1 from lv where lv.sensio_id=hist_venda.sensio_id and lv.status='aberto')`)]).catch(() => {});
        }
        const n = await one(DB, `select count(*) n from ${tab}`);
        return json(req, { ok: true, gravadas: linhas.length, total_na_tabela: n.n });
      }
      if (p === '/api/hist/resumo') {
        // conferência semana a semana (seg–dom, horário de Manaus): OPs finalizadas e entradas de OP no P.A.
        const sem = c => `date(datetime(${c},'-4 hours'), 'weekday 0', '-6 days')`;
        const [ops, entradas, tot] = await Promise.all([
          all(DB, `select ${sem('finalizado_em')} semana, count(*) ops, sum(qtd) pecas from hist_op where status='FINALIZADO' and finalizado_em is not null group by 1 order by 1`),
          all(DB, `select ${sem('data')} semana, count(*) movs, sum(qtd) pecas from hist_estoque_mov where deposito='P.A.' and tipo='Entrada' and documento like 'OP %' and coalesce(cancelado,0)=0 group by 1 order by 1`),
          one(DB, `select (select count(*) from hist_op) op, (select count(*) from hist_op_etapa) etapa, (select count(*) from hist_op_evento) evento, (select count(*) from hist_estoque_mov) mov, (select count(*) from hist_venda) venda, (select count(*) from hist_nfe) nfe`),
        ]);
        return json(req, { totais: tot, ops, entradas });
      }
      if ((m = p.match(/^\/api\/pedidos\/([^/]+)$/)) && req.method === 'GET') {
        const pd = await one(DB, 'select * from pedido where numero=?', decodeURIComponent(m[1]));
        const histSensio = async num => { const v = await one(DB, 'select * from hist_venda where codigo=?', Number(num)); if (!v) return null;
          const [nfes, envios] = await Promise.all([all(DB, 'select numero, data, status, valor from hist_nfe where venda_sensio_id=? order by data', v.sensio_id),
            all(DB, `select data, deposito, item_codigo, item_nome, -qtd qtd, documento from hist_estoque_mov where tipo='Saída' and coalesce(cancelado,0)=0 and (documento in ('Venda ' || ?, 'Venda Consignada ' || ?, 'Bonificação/Remessa ' || ?, 'Outros ' || ?) or documento like '% Venda ' || ? or documento like '% Venda Consignada ' || ?) order by data`, ...Array(6).fill(String(v.codigo)))]);
          return { ...v, nfes, envios }; };
        if (!pd) { const h = await histSensio(decodeURIComponent(m[1])); if (h) return json(req, { numero: String(h.codigo), cliente: h.cliente, tipo: h.tipo, status: h.status, origem: 'sensio', data_pagamento: h.data_pagamento, data_faturamento: h.data_faturamento, itens: [], ops: [], envios: [], historico_sensio: h }); }
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
            , (select count(*) from foto f where f.envio_id=e.id) fotos from envio e where e.pedido_id=? order by e.id desc`, pd.id)]);
        return json(req, { ...pd, itens, ops, envios, historico_sensio: await histSensio(pd.numero) });
      }
      if ((m = p.match(/^\/api\/pedidos\/([^/]+)\/tipo$/)) && req.method === 'POST') {
        if (!TIPOS_PEDIDO.includes(body.tipo)) return json(req, { erro: 'Tipo tem que ser: ' + TIPOS_PEDIDO.join(', ') }, 400);
        const r = await DB.prepare('update pedido set tipo=? where numero=?').bind(body.tipo, decodeURIComponent(m[1])).run();
        return json(req, { ok: true });
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
            coalesce((select sum(qtd) from estoque_mov where item_id=i.id and deposito_id=?),0) saldo_sp,
            coalesce((select sum(qtd) from estoque_mov where item_id=i.id and deposito_id=?),0) saldo_patio
          from item i where (i.nome like ? or i.codigo like ?) ${q('tipo') ? 'and i.tipo=?' : ''} order by i.tipo desc, i.codigo limit 400`,
          DEP_PA, DEP_PA_SP, DEP_PATIO, busca, busca, ...(q('tipo') ? [q('tipo')] : [])));
      }
      if ((m = p.match(/^\/api\/itens\/(\d+)\/produz$/)) && req.method === 'POST') {
        await DB.prepare('update item set produz=? where id=?').bind(body.produz ? 1 : 0, Number(m[1])).run();
        return json(req, { ok: true });
      }

      // ---------- insumos (lixa, verniz, cola…): ficam no depósito Insumos; entrada = compra, saída = uso por setor, acerto = contagem
      if (p === '/api/insumos' && req.method === 'GET') {
        return json(req, await all(DB, `select i.id, i.codigo, i.nome, i.unidade, i.estoque_min, i.ativo,
            coalesce((select sum(qtd) from estoque_mov where item_id=i.id and deposito_id=?),0) saldo,
            (select max(data) from estoque_mov where item_id=i.id and deposito_id=? and qtd<0) ultimo_uso,
            coalesce((select -sum(qtd) from estoque_mov where item_id=i.id and deposito_id=? and qtd<0 and motivo like 'Uso%' and data>=datetime('now','-30 days')),0) uso_30d
          from item i where i.tipo='Insumo' order by i.ativo desc, i.nome`, DEP_INSUMOS, DEP_INSUMOS, DEP_INSUMOS));
      }
      if (p === '/api/insumos' && req.method === 'POST') {
        const nome = String(body.nome || '').trim(); if (!nome) return json(req, { erro: 'Coloque o nome do insumo' }, 400);
        const min = body.estoque_min === '' || body.estoque_min == null ? null : Number(body.estoque_min);
        if (body.id) {
          await DB.prepare("update item set nome=?, unidade=?, estoque_min=?, ativo=? where id=? and tipo='Insumo'").bind(nome, body.unidade || null, min, body.ativo === 0 ? 0 : 1, Number(body.id)).run();
          return json(req, { ok: true, id: Number(body.id) });
        }
        if (await one(DB, "select 1 from item where tipo='Insumo' and lower(nome)=lower(?)", nome)) return json(req, { erro: 'Já existe um insumo com esse nome' }, 400);
        const ult = await one(DB, "select max(cast(substr(codigo,4) as int)) n from item where codigo like 'INS%'");
        const codigo = 'INS' + String(((ult && ult.n) || 0) + 1).padStart(4, '0');
        const r = await DB.prepare("insert into item(codigo, nome, tipo, unidade, estoque_min, ativo, produz) values(?,?,'Insumo',?,?,1,0)").bind(codigo, nome, body.unidade || null, min).run();
        return json(req, { ok: true, id: r.meta.last_row_id, codigo });
      }
      if (p === '/api/insumos/mov' && req.method === 'POST') {
        const it = await one(DB, "select * from item where id=? and tipo='Insumo'", Number(body.item_id)); if (!it) return json(req, { erro: 'Insumo não encontrado' }, 404);
        const q2 = Number(String(body.qtd ?? '').replace(',', '.')); if (!(q2 >= 0) || (body.tipo !== 'acerto' && !(q2 > 0))) return json(req, { erro: 'Coloque a quantidade' }, 400);
        const saldo = (await one(DB, 'select coalesce(sum(qtd),0) s from estoque_mov where item_id=? and deposito_id=?', it.id, DEP_INSUMOS)).s;
        const un = it.unidade ? ' ' + it.unidade : '', obs = body.obs ? ' — ' + body.obs : '';
        let qtd, motivo;
        if (body.tipo === 'entrada') { qtd = q2; motivo = 'Compra' + (body.fornecedor ? ' · ' + body.fornecedor : '') + (body.doc ? ' · ' + body.doc : '') + obs; }
        else if (body.tipo === 'saida') {
          if (q2 > saldo + 1e-9) return json(req, { erro: `Só tem ${+saldo.toFixed(3)}${un} no estoque. Se a contagem estiver errada, use "Acertar".` }, 400);
          qtd = -q2; motivo = 'Uso' + (body.setor ? ' · ' + body.setor : '') + obs; }
        else if (body.tipo === 'acerto') { qtd = q2 - saldo; if (Math.abs(qtd) < 1e-9) return json(req, { ok: true, igual: true }); motivo = `Acerto pela contagem (contado ${q2}${un})` + obs; }
        else return json(req, { erro: 'Tipo inválido' }, 400);
        await DB.prepare('insert into estoque_mov(item_id, deposito_id, qtd, motivo) values(?,?,?,?)').bind(it.id, DEP_INSUMOS, qtd, motivo).run();
        return json(req, { ok: true, saldo: saldo + qtd });
      }
      if (p === '/api/insumos/movs') {
        const id = Number(q('item_id') || 0);
        return json(req, await all(DB, `select m.id, m.data, m.qtd, m.motivo, m.usuario_nome, i.nome, i.unidade from estoque_mov m join item i on i.id=m.item_id
          where m.deposito_id=? and i.tipo='Insumo' ${id ? 'and m.item_id=?' : ''} order by m.id desc limit 200`, DEP_INSUMOS, ...(id ? [id] : [])));
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
      if (p === '/api/estoque' && req.method === 'GET' && q('visao') === 'pa') {
        // P.A. Manaus e P.A. São Paulo lado a lado (a peça é uma só; o depósito diz onde ela está)
        return json(req, await all(DB, `select i.id, i.codigo, i.nome, round(sum(case when m.deposito_id=? then m.qtd else 0 end),3) manaus, round(sum(case when m.deposito_id=? then m.qtd else 0 end),3) sp
          from estoque_mov m join item i on i.id=m.item_id where m.deposito_id in (?,?) group by i.id having abs(manaus)>0.0001 or abs(sp)>0.0001 order by i.nome`, DEP_PA, DEP_PA_SP, DEP_PA, DEP_PA_SP));
      }
      // ---------- transferência entre depósitos (ex.: P.A. Manaus → P.A. São Paulo / showroom), com histórico e documento que foi junto
      if (p === '/api/estoque/transferir' && req.method === 'POST') {
        const de = Number(body.de_id), para = Number(body.para_id), L = (Array.isArray(body.itens) ? body.itens : []).map(x => ({ item_id: Number(x.item_id), qtd: Number(x.qtd) })).filter(x => x.item_id && x.qtd > 0);
        if (!de || !para || de === para) return json(req, { erro: 'Escolha o depósito de saída e o de chegada (diferentes)' }, 400);
        if (!L.length) return json(req, { erro: 'Coloque as peças e as quantidades' }, 400);
        for (const x of L) {
          const s = await one(DB, 'select i.nome, coalesce((select sum(qtd) from estoque_mov where item_id=i.id and deposito_id=?),0) saldo from item i where i.id=?', de, x.item_id);
          if (!s) return json(req, { erro: 'Peça não encontrada' }, 400);
          if (x.qtd > s.saldo + 0.0001) return json(req, { erro: `${s.nome}: só tem ${s.saldo} no depósito de saída` }, 400);
        }
        const data = /^\d{4}-\d{2}-\d{2}$/.test(body.data || '') ? body.data : new Date(Date.now() - 4 * 36e5).toISOString().slice(0, 10);
        const r = await DB.prepare('insert into transferencia(data, de_id, para_id, documento, transportadora, obs, criado_por, criado_nome) values(?,?,?,?,?,?,?,?)')
          .bind(data, de, para, String(body.documento || '').trim() || null, String(body.transportadora || '').trim() || null, String(body.obs || '').trim() || null, usuario.id || null, usuario.nome || null).run();
        const id = r.meta.last_row_id, nomes = Object.fromEntries((await all(DB, 'select id, nome from deposito')).map(d => [d.id, d.nome]));
        await DB.batch(L.flatMap(x => [
          DB.prepare('insert into transferencia_item(transferencia_id, item_id, qtd) values(?,?,?)').bind(id, x.item_id, x.qtd),
          DB.prepare('insert into estoque_mov(item_id, deposito_id, qtd, motivo) values(?,?,?,?)').bind(x.item_id, de, -x.qtd, `Envio #${id} para ${nomes[para] || para}`),
          DB.prepare('insert into estoque_mov(item_id, deposito_id, qtd, motivo) values(?,?,?,?)').bind(x.item_id, para, x.qtd, `Envio #${id} vindo de ${nomes[de] || de}`)]));
        return json(req, { ok: true, id });
      }
      if (p === '/api/estoque/transferencias') {
        return json(req, await all(DB, `select t.*, dd.nome de, dp.nome para, (select sum(qtd) from transferencia_item where transferencia_id=t.id) pecas,
            (select group_concat(i.nome || ' (' || cast(ti.qtd as int) || ')', ', ') from transferencia_item ti join item i on i.id=ti.item_id where ti.transferencia_id=t.id) itens
          from transferencia t join deposito dd on dd.id=t.de_id join deposito dp on dp.id=t.para_id order by t.data desc, t.id desc limit 200`));
      }
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
        // filtros opcionais: de / ate (AAAA-MM-DD, horário de Manaus) e deposito_id; sem filtro = as 100 últimas
        const w2 = [], b2 = [], de = q('de'), ate = q('ate'), dep = Number(q('deposito_id') || 0);
        if (de) { w2.push("date(m.data,'-4 hours') >= ?"); b2.push(de); }
        if (ate) { w2.push("date(m.data,'-4 hours') <= ?"); b2.push(ate); }
        if (dep) { w2.push('m.deposito_id=?'); b2.push(dep); }
        const lim = w2.length ? Math.min(20000, Number(q('limite')) || 20000) : 100;
        const atual = await all(DB, `select m.id, m.data, datetime(m.data,'-4 hours') data_manaus, m.item_id, i.codigo, i.nome, i.tipo item_tipo, m.deposito_id, d.nome deposito, m.qtd, m.motivo, m.op_id, m.usuario_nome, 'sistema' origem
          from estoque_mov m join item i on i.id=m.item_id join deposito d on d.id=m.deposito_id ${w2.length ? 'where ' + w2.join(' and ') : ''} order by m.id desc limit ${lim}`, ...b2);
        if (!w2.length || q('origem') === 'sistema') return json(req, atual);
        // histórico do Sensio (não entra no saldo): mesmos filtros; deposito_id só existe para P.A., Showroom, Pátio e Defeito; deposito_nome filtra pelo nome do Sensio
        const w3 = [], b3 = [];
        if (de) { w3.push("date(data,'-4 hours') >= ?"); b3.push(de); }
        if (ate) { w3.push("date(data,'-4 hours') <= ?"); b3.push(ate); }
        if (dep) { w3.push('deposito_id=?'); b3.push(dep); }
        if (q('deposito_nome')) { w3.push('deposito=?'); b3.push(q('deposito_nome')); }
        const hist = await all(DB, `select sensio_id id, data, datetime(data,'-4 hours') data_manaus, null item_id, item_codigo codigo, item_nome nome, item_tipo, deposito_id, deposito, qtd, documento motivo, null op_id, usuario usuario_nome, 'sensio' origem, cancelado
          from hist_estoque_mov ${w3.length ? 'where ' + w3.join(' and ') : ''} order by data desc limit ${lim}`, ...b3);
        return json(req, [...atual, ...hist].sort((a, b) => a.data < b.data ? 1 : -1).slice(0, lim));
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
            from pedido p where p.status in ('Em produção','Pronto / embalagem') and coalesce(p.tipo,'cliente')='cliente' and p.prazo is not null and p.prazo <= date(?, '+7 days') order by p.prazo`, hoje),
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
          all(DB, `select o.codigo, o.qtd, i.nome, pd.numero, pd.tipo tipo_pedido from op o join item i on i.id=o.item_id left join pedido_item pi on pi.id=o.pedido_item_id left join pedido pd on pd.id=pi.pedido_id
            where o.status='finalizada' and o.finalizado_em between ? and ? order by o.finalizado_em`, d0, d1),
          one(DB, "select count(*) n, coalesce(sum(qtd),0) pecas from op where origem is null and criado_em between ? and ?", d0, d1),
          all(DB, `select e.id envio_id, e.data, p.numero, p.cliente, coalesce(p.tipo,'cliente') tipo_pedido, e.transportadora, (select sum(qtd) from envio_item where envio_id=e.id) pecas,
            (select count(*) from foto f where f.envio_id=e.id) fotos, case when exists (select 1 from foto f where f.envio_id=e.id) then 1 else 0 end tem_foto from envio e join pedido p on p.id=e.pedido_id
            where e.data between ? and ? order by e.data`, de, ate),
          all(DB, `select e.data, e.fornecedor, (select sum(qtd) from entrada_item where entrada_id=e.id) qtd from entrada e where e.data between ? and ?`, de, ate),
          all(DB, `select v.id, d.nome deposito, (select count(*) from inventario_item where inventario_id=v.id and abs(coalesce(ajuste,0))>0.0001) ajustes from inventario v join deposito d on d.id=v.deposito_id
            where v.status='fechado' and v.fechado_em between ? and ?`, d0, d1),
        ]);
        // histórico do Sensio no mesmo período (dia de Manaus); OPs que também existem aqui ficam de fora pra não contar duas vezes
        const [hf, hn, he] = await Promise.all([
          all(DB, `select h.codigo, h.qtd, h.item_nome nome, h.pedido_numero numero, (select v.tipo from hist_venda v where cast(v.codigo as text)=h.pedido_numero) tipo_pedido, datetime(h.finalizado_em,'-4 hours') finalizado_manaus, 'sensio' origem
            from hist_op h where h.status='FINALIZADO' and date(h.finalizado_em,'-4 hours') between ? and ? and not exists (select 1 from op o where o.codigo=h.codigo) order by h.finalizado_em`, de, ate),
          all(DB, `select n.numero nf, date(n.data,'-4 hours') data, n.valor, n.cliente, n.venda_codigo numero, v.tipo tipo_pedido, 'sensio' origem from hist_nfe n left join hist_venda v on v.sensio_id=n.venda_sensio_id
            where n.status='Autorizada' and date(n.data,'-4 hours') between ? and ? order by n.data`, de, ate),
          one(DB, `select count(*) movs, coalesce(sum(qtd),0) pecas from hist_estoque_mov where deposito='P.A.' and tipo='Entrada' and documento like 'OP %' and coalesce(cancelado,0)=0 and date(data,'-4 hours') between ? and ?`, de, ate)]);
        return json(req, { finalizadas, criadas, envios, entradas, inventarios, historico_sensio: { finalizadas: hf, faturamento: hn, entradas_pa_por_op: he } });
      }

      // ---------- fotos (guardadas no banco já reduzidas pelo navegador)
      if (p === '/api/fotos' && req.method === 'GET') {
        const campo = q('op_id') ? 'op_id' : q('defeito_id') ? 'defeito_id' : q('pedido_item_id') ? 'pedido_item_id' : q('qualidade_id') ? 'qualidade_id' : q('envio_id') ? 'envio_id' : null;
        if (q('pedido')) return json(req, await all(DB, `select * from (
            select f.id, f.nome, f.criado_em, i.codigo, i.nome item, o.codigo op_codigo from foto f join op o on o.id=f.op_id join item i on i.id=o.item_id
              join pedido_item pi on pi.id=o.pedido_item_id join pedido pd on pd.id=pi.pedido_id where pd.numero=?
            union all
            select f.id, f.nome, f.criado_em, coalesce(i.codigo, pi.descricao) codigo, coalesce(i.nome, pi.descricao) item, null op_codigo from foto f join pedido_item pi on pi.id=f.pedido_item_id
              left join item i on i.id=pi.item_id join pedido pd on pd.id=pi.pedido_id where pd.numero=?
            union all
            select f.id, f.nome, f.criado_em, 'ENVIO' codigo, 'Envio de ' || e.data || coalesce(' · ' || e.transportadora, '') item, null op_codigo from foto f join envio e on e.id=f.envio_id
              join pedido pd on pd.id=e.pedido_id where pd.numero=?) order by codigo, id`, q('pedido'), q('pedido'), q('pedido')));
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
        if (!body.op_id && !body.defeito_id && !body.pedido_item_id && !body.qualidade_id && !body.envio_id) return json(req, { erro: 'Foto sem OP/defeito/pedido/envio' }, 400);
        const r = await DB.prepare('insert into foto(op_id, defeito_id, pedido_item_id, qualidade_id, envio_id, nome, dados) values(?,?,?,?,?,?,?)').bind(body.op_id || null, body.defeito_id || null, body.pedido_item_id || null, body.qualidade_id || null, body.envio_id || null, body.nome || null, body.dados).run();
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
            (select group_concat(classe, '') from (select classe from peca_qualidade q where q.op_id=o.id order by numero)) classes,
            (select json_group_array(json_object('numero', numero, 'classe', classe, 'resultado', resultado, 'obs', obs, 'data_cq', coalesce(atualizado_em, criado_em)))
               from (select * from peca_qualidade q where q.op_id=o.id order by numero)) pecas_cq
          from op o join item i on i.id=o.item_id left join pedido_item pi on pi.id=o.pedido_item_id left join pedido pd on pd.id=pi.pedido_id
          where o.status='finalizada' and o.tipo='OP' and o.finalizado_em >= datetime('now', ?) order by o.finalizado_em desc`, `-${dias} days`);
        return json(req, l.map(o => ({ ...o, pecas: Math.max(1, Math.ceil(o.qtd - 1e-9)), pecas_cq: JSON.parse(o.pecas_cq || '[]') })));
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
        const res = body.resultado || null; if (res && !['aprovada', 'reprovada', 'retrabalho'].includes(res)) return json(req, { erro: 'Resultado tem que ser aprovada, reprovada ou retrabalho' }, 400);
        await DB.prepare(`insert into peca_qualidade(op_id, numero, classe, obs, resultado) values(?,?,?,?,?)
          on conflict(op_id, numero) do update set classe=excluded.classe, obs=excluded.obs, resultado=excluded.resultado, atualizado_em=datetime('now')`).bind(o.id, n, body.classe, body.obs || null, res).run();
        const r = await one(DB, 'select id from peca_qualidade where op_id=? and numero=?', o.id, n);
        await evento(DB, o.id, `Qualidade: peça ${n} classificada ${body.classe}` + (res ? ` · ${res}` : '') + (body.obs ? ` (${body.obs})` : '')).run();
        return json(req, { ok: true, id: r.id });
      }

      // ---------- metas de peças por dia POR FUNCIONÁRIO (tabela do Wilson, 13/11/2026): grupo TA/TB/AC/MA/MB × peça (com tamanho)
      if (p === '/api/metas' && req.method === 'GET') {
        const [metas, funcs] = await Promise.all([all(DB, 'select * from meta_func'), all(DB, 'select id, nome, setor_id from funcionario where ativo=1 order by nome')]);
        return json(req, { grupos: GRUPOS_META, chaves: CHAVES_META, metas, funcionarios: funcs });
      }
      if (p === '/api/metas' && req.method === 'POST') {
        if (!usuario.admin) return json(req, { erro: 'Só o administrador muda as metas' }, 403);
        const l = Array.isArray(body.metas) ? body.metas : [];
        await DB.batch(l.map(x => Number(x.pecas_dia) > 0
          ? DB.prepare('insert or replace into meta_func(funcionario_id, grupo, chave, pecas_dia) values(?,?,?,?)').bind(Number(x.funcionario_id), x.grupo, x.chave, Number(x.pecas_dia))
          : DB.prepare('delete from meta_func where funcionario_id=? and grupo=? and chave=?').bind(Number(x.funcionario_id), x.grupo, x.chave)));
        return json(req, { ok: true });
      }

      // ---------- eficiência por funcionário = peças feitas ÷ meta dele (peças/dia naquela etapa e peça), por dia trabalhado
      if (p === '/api/eficiencia') {
        const de = q('de'), ate = q('ate'), setor = Number(q('setor_id')) || 0;
        const fs = setor ? 'and f.setor_id=' + setor : '';
        const desde = new Date(Date.parse(ate + 'T12:00:00Z') - 63 * 864e5).toISOString().slice(0, 10);
        const ini = de < desde ? de : desde;
        const [metas, etapas, opsTodas, extra, defs, funcs] = await Promise.all([
          all(DB, 'select funcionario_id, grupo, chave, pecas_dia from meta_func'),
          all(DB, `select oo.funcionario_id fid, oo.op_id, oo.tempo_unit_min tu, t.nome tipo, op.qtd, i.nome item, date(oo.fim, '-4 hours') dia
            from op_operacao oo join op on op.id=oo.op_id join operacao_tipo t on t.id=oo.operacao_tipo_id join item i on i.id=op.item_id join funcionario f on f.id=oo.funcionario_id
            where oo.status='finalizado' and t.espera=0 and op.tipo='OP' and date(oo.fim, '-4 hours') between ? and ? ${fs}`, ini, ate),
          all(DB, `select oo.op_id, t.nome tipo, oo.tempo_unit_min tu from op_operacao oo join operacao_tipo t on t.id=oo.operacao_tipo_id
            where t.espera=0 and oo.op_id in (select op_id from op_operacao where status='finalizado' and date(fim, '-4 hours') between ? and ?)`, ini, ate),
          all(DB, `select f.id, sum(op.tipo='OP' and oo.sem_registro=1) sem_registro, sum(op.tipo='RT') rt_feitos, sum(case when op.tipo='RT' then oo.minutos else 0 end) rt_minutos
            from op_operacao oo join op on op.id=oo.op_id join operacao_tipo t on t.id=oo.operacao_tipo_id join funcionario f on f.id=oo.funcionario_id
            where oo.status='finalizado' and t.espera=0 and date(oo.fim, '-4 hours') between ? and ? ${fs} group by f.id`, de, ate),
          all(DB, `select d.funcionario_id id, count(*) regs, sum(d.qtd) pecas, sum((select count(*) from op x where x.defeito_id=d.id)) rts
            from defeito d where d.funcionario_id is not null and date(d.data, '-4 hours') between ? and ? group by d.funcionario_id`, de, ate),
          all(DB, `select f.id, f.nome, f.setor_id, s.nome setor from funcionario f left join setor s on s.id=f.setor_id where f.ativo=1 ${fs} order by f.nome`),
        ]);
        const MF = {}; metas.forEach(m => MF[m.funcionario_id + '|' + m.grupo + '|' + m.chave] = m.pecas_dia);
        const SG = {}; opsTodas.forEach(x => { const g = grupoMeta(x.tipo); if (!g) return; const k = x.op_id + '|' + g; SG[k] = SG[k] || { s: 0, n: 0 }; SG[k].s += Number(x.tu) || 0; SG[k].n++; });
        const seg = d => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
        const P = {}; funcs.forEach(f => P[f.id] = { ...f, credito: 0, pecas_meta: 0, dias: new Set(), sem_meta: 0, semanas: {}, porPeca: {} });
        for (const e of etapas) {
          const f = P[e.fid]; if (!f) continue;
          const g = grupoMeta(e.tipo), ch = chaveMeta(e.item), meta = g && ch ? MF[e.fid + '|' + g + '|' + ch] : null;
          const so = g && SG[e.op_id + '|' + g], share = so && so.s > 0 ? (Number(e.tu) || 0) / so.s : 1 / ((so && so.n) || 1);
          const eq = Number(e.qtd) * share;
          const w = seg(e.dia), sw = f.semanas[w] = f.semanas[w] || { credito: 0, dias: new Set() };
          sw.dias.add(e.dia);
          if (meta) sw.credito += eq / meta;
          if (e.dia >= de && e.dia <= ate) {
            f.dias.add(e.dia);
            if (meta) { f.credito += eq / meta; f.pecas_meta += eq; const k = ch + '|' + g, pp = f.porPeca[k] = f.porPeca[k] || { peca: nomeChave(ch), etapa: NOME_GRUPO[g], pecas: 0, meta }; pp.pecas += eq; } else f.sem_meta++;
          }
        }
        const X = {}; extra.forEach(x => X[x.id] = x); const D = {}; defs.forEach(d => D[d.id] = d);
        const lista = Object.values(P).map(f => {
          const x = X[f.id] || {}, d = D[f.id] || {}, dias = f.dias.size;
          const semanas = {}; Object.entries(f.semanas).forEach(([w, v]) => { if (v.dias.size && v.credito > 0) semanas[w] = Math.round(v.credito / v.dias.size * 100); });
          return { id: f.id, nome: f.nome, setor: f.setor, setor_id: f.setor_id, dias, pecas: Math.round(f.pecas_meta * 10) / 10, sem_meta: f.sem_meta,
            eficiencia: dias && f.credito > 0 ? Math.round(f.credito / dias * 100) : (dias ? 0 : null), metas_cumpridas: Math.round(f.credito * 100) / 100,
            porPeca: Object.values(f.porPeca).map(v => ({ ...v, pecas: Math.round(v.pecas * 10) / 10 })),
            sem_registro: x.sem_registro || 0, rt_feitos: x.rt_feitos || 0, rt_minutos: x.rt_minutos || 0,
            defeitos: d.regs || 0, pecas_defeito: d.pecas || 0, rts_gerados: d.rts || 0, semanas };
        }).sort((a, b) => (b.eficiencia ?? -1) - (a.eficiencia ?? -1) || b.pecas - a.pecas || a.nome.localeCompare(b.nome));
        return json(req, { lista });
      }

      // aviso de cobrança pra expedição (qualquer usuário logado; só totais, sem detalhes)
      if ((m = p.match(/^\/api\/alerta-financeiro\/([^/]+)$/))) {
        if (!finPronto) { await DB.batch(FIN_DDL.map(s => DB.prepare(s))); finPronto = true; }
        const ped = await one(DB, 'select id, numero from pedido where numero=?', decodeURIComponent(m[1]));
        if (!ped) return json(req, { vencido: 0, aberto: 0 });
        const f = await finDoPedido(DB, ped);
        return json(req, { vencido: f.vencido, aberto: f.aberto });
      }
      // ---------- FINANCEIRO (contas, categorias, centros de custo, lançamentos, fluxo de caixa, DRE). Tela 'fin'.
      if (p.startsWith('/api/fin/')) {
        if (!finPronto) { await DB.batch(FIN_DDL.map(s => DB.prepare(s))); for (const s of FIN_ALTER) await DB.prepare(s).run().catch(() => {}); finPronto = true; }
        const HOJE = "date('now','-4 hours')";
        const num = v => Math.round((Number(v) || 0) * 100) / 100;
        const dataOk = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
        const SALDO = `c.saldo_inicial + coalesce((select sum(case when l.tipo='R' then l.pago when l.tipo='P' then -l.pago when l.tipo='T' and l.conta_destino_id is not null then -l.pago else 0 end)
            from fin_lancamento l where l.conta_id=c.id and l.status!='cancelado'), 0) + coalesce((select sum(l.pago) from fin_lancamento l where l.tipo='T' and l.conta_destino_id=c.id and l.status!='cancelado'), 0)`;
        const contas = () => all(DB, `select c.*, round(${SALDO}, 2) saldo from fin_conta c order by c.ativo desc, c.nome`);
        if (p === '/api/fin/base') {
          const [cs, cats, cens] = await Promise.all([contas(), all(DB, 'select * from fin_categoria order by tipo desc, nome'), all(DB, 'select * from fin_centro order by nome')]);
          return json(req, { contas: cs, categorias: cats, centros: cens, hoje: (await one(DB, `select ${HOJE} d`)).d });
        }
        if (p === '/api/fin/resumo') {
          const [cs, r] = await Promise.all([contas(), one(DB, `select
              sum(case when tipo='R' and status='aberto' and vencimento < ${HOJE} then valor-pago end) receber_vencido,
              sum(case when tipo='P' and status='aberto' and vencimento < ${HOJE} then valor-pago end) pagar_vencido,
              sum(case when tipo='R' and status='aberto' and vencimento = ${HOJE} then valor-pago end) receber_hoje,
              sum(case when tipo='P' and status='aberto' and vencimento = ${HOJE} then valor-pago end) pagar_hoje,
              sum(case when tipo='R' and status='aberto' and vencimento between ${HOJE} and date(${HOJE},'+7 days') then valor-pago end) receber_7,
              sum(case when tipo='P' and status='aberto' and vencimento between ${HOJE} and date(${HOJE},'+7 days') then valor-pago end) pagar_7,
              sum(case when tipo='R' and status='aberto' and substr(vencimento,1,7) = substr(${HOJE},1,7) then valor-pago end) receber_mes,
              sum(case when tipo='P' and status='aberto' and substr(vencimento,1,7) = substr(${HOJE},1,7) then valor-pago end) pagar_mes,
              sum(case when tipo='R' and status!='cancelado' and substr(quitacao,1,7) = substr(${HOJE},1,7) then pago end) recebido_mes,
              sum(case when tipo='P' and status!='cancelado' and substr(quitacao,1,7) = substr(${HOJE},1,7) then pago end) pago_mes,
              sum(case when tipo='P' and status='aberto' and aprovado=0 then 1 else 0 end) a_aprovar
            from fin_lancamento`)]);
          const [vencidosR, proximos] = await Promise.all([
            all(DB, `select id, tipo, descricao, pessoa, vencimento, round(valor-pago,2) aberto, cast(julianday(${HOJE})-julianday(vencimento) as int) dias from fin_lancamento where tipo='R' and status='aberto' and vencimento < ${HOJE} order by vencimento`),
            all(DB, `select id, tipo, descricao, pessoa, vencimento, round(valor-pago,2) aberto from fin_lancamento where tipo in ('P','R') and status='aberto' and vencimento between ${HOJE} and date(${HOJE},'+7 days') order by vencimento, tipo`)]);
          return json(req, { contas: cs, saldo: num(cs.filter(c => c.ativo).reduce((a, c) => a + c.saldo, 0)), ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, num(v)])), vencidosR, proximos });
        }
        if ((m = p.match(/^\/api\/fin\/lancamentos\/(\d+)$/)) && req.method === 'GET') {
          const l = await one(DB, `select l.*, round(l.valor-l.pago,2) aberto, (l.status='aberto' and l.vencimento < ${HOJE}) vencido, (select numero from pedido where id=l.pedido_id) pedido_numero from fin_lancamento l where l.id=?`, Number(m[1]));
          return l ? json(req, l) : json(req, { erro: 'Lançamento não encontrado' }, 404);
        }
        if (p === '/api/fin/lancamentos' && req.method === 'GET') {
          const campo = ['vencimento', 'quitacao', 'competencia'].includes(q('campo')) ? q('campo') : 'vencimento';
          const w = ['1=1'], b = [];
          if (dataOk(q('de'))) { w.push(`l.${campo} >= ?`); b.push(q('de')); }
          if (dataOk(q('ate'))) { w.push(`l.${campo} <= ?`); b.push(q('ate')); }
          if (['P', 'R', 'T'].includes(q('tipo'))) { w.push('l.tipo=?'); b.push(q('tipo')); }
          const st = q('status') || 'todos';
          if (st === 'aberto') w.push("l.status='aberto'"); else if (st === 'quitado') w.push("l.status='quitado'");
          else if (st === 'vencido') w.push(`l.status='aberto' and l.vencimento < ${HOJE}`); else if (st === 'cancelado') w.push("l.status='cancelado'"); else if (st === 'aprovar') w.push("l.status='aberto' and l.aprovado=0"); else w.push("l.status!='cancelado'");
          for (const [k, col] of [['conta_id', 'l.conta_id'], ['categoria_id', 'l.categoria_id'], ['centro_id', 'l.centro_id']]) if (Number(q(k))) { w.push(col + '=?'); b.push(Number(q(k))); }
          if (q('q')) { w.push('(l.descricao like ? or l.pessoa like ? or l.nf like ? or l.obs like ?)'); const s = '%' + q('q') + '%'; b.push(s, s, s, s); }
          const where = w.join(' and ');
          const [lista, tot] = await Promise.all([
            all(DB, `select l.*, round(l.valor-l.pago,2) aberto, c.nome conta, cd.nome conta_destino, ca.nome categoria, ce.nome centro, (l.status='aberto' and l.vencimento < ${HOJE}) vencido, (select count(*) from fin_anexo a where a.lancamento_id=l.id) anexos
              from fin_lancamento l left join fin_conta c on c.id=l.conta_id left join fin_conta cd on cd.id=l.conta_destino_id left join fin_categoria ca on ca.id=l.categoria_id left join fin_centro ce on ce.id=l.centro_id
              where ${where} order by l.${campo} ${q('ordem') === 'desc' ? 'desc' : 'asc'}, l.id limit 1500`, ...b),
            all(DB, `select l.tipo, count(*) n, round(sum(l.valor),2) valor, round(sum(l.pago),2) pago, round(sum(case when l.status='aberto' then l.valor-l.pago else 0 end),2) aberto from fin_lancamento l where ${where} group by l.tipo`, ...b)]);
          return json(req, { lista, totais: tot, limite: lista.length >= 1500 });
        }
        const ids = async () => ({ conta: Number(body.conta_id) || null, destino: Number(body.conta_destino_id) || null, cat: Number(body.categoria_id) || null, centro: Number(body.centro_id) || null });
        if (p === '/api/fin/lancamentos' && req.method === 'POST') {
          const tipo = body.tipo, valor = num(body.valor), n = Math.min(120, Math.max(1, Math.floor(Number(body.parcelas) || 1)));
          if (!['P', 'R', 'T'].includes(tipo)) return json(req, { erro: 'Escolha: a pagar, a receber ou transferência' }, 400);
          if (!(valor > 0)) return json(req, { erro: 'Coloque o valor' }, 400);
          if (!dataOk(body.vencimento)) return json(req, { erro: 'Coloque a data de vencimento' }, 400);
          const descricao = String(body.descricao || '').trim() || (tipo === 'T' ? 'Transferência entre contas' : '');
          if (!descricao) return json(req, { erro: 'Coloque a descrição' }, 400);
          const x = await ids();
          if (body.pedido_numero) { const pd = await one(DB, 'select id from pedido where numero=?', String(body.pedido_numero).trim()); if (!pd) return json(req, { erro: 'Pedido ' + body.pedido_numero + ' não encontrado' }, 400); body.pedido_id = pd.id; }
          if (tipo === 'T' && (!x.conta || !x.destino || x.conta === x.destino)) return json(req, { erro: 'Na transferência escolha a conta de saída e a de entrada (diferentes)' }, 400);
          const quitado = tipo === 'T' || !!body.quitado, dq = dataOk(body.quitacao) ? body.quitacao : body.vencimento;
          if (quitado && !x.conta) return json(req, { erro: 'Pra marcar como pago/recebido, escolha a conta' }, 400);
          const base = Math.floor(valor / n * 100) / 100, st = [];
          for (let i = 0; i < n; i++) {
            const v = i === n - 1 ? num(valor - base * (n - 1)) : base;
            const d = new Date(body.vencimento + 'T12:00:00Z'); const dia = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + i);
            const fim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(dia, fim));
            const venc = d.toISOString().slice(0, 10), q1 = quitado && i === 0;
            st.push(DB.prepare(`insert into fin_lancamento(tipo, descricao, obs, pessoa, conta_id, conta_destino_id, categoria_id, centro_id, metodo, valor, pago, vencimento, competencia, quitacao, parcela, nf, pedido_id, status, criado_por, aprovado)
              values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(tipo, descricao, String(body.obs || '').trim() || null, String(body.pessoa || '').trim() || null, x.conta, tipo === 'T' ? x.destino : null, tipo === 'T' ? null : x.cat, x.centro,
              String(body.metodo || '').trim() || null, v, q1 ? v : 0, venc, dataOk(body.competencia) ? body.competencia : venc, q1 ? dq : null, n > 1 ? `${i + 1}/${n}` : null, String(body.nf || '').trim() || null, Number(body.pedido_id) || null, q1 ? 'quitado' : 'aberto', usuario.id || null, tipo === 'P' && !usuario.admin && !q1 ? 0 : 1));
          }
          await DB.batch(st);
          return json(req, { ok: true, criados: n });
        }
        if ((m = p.match(/^\/api\/fin\/lancamentos\/(\d+)(?:\/(quitar|estornar|cancelar|reativar|aprovar))?$/)) && req.method === 'POST') {
          const l = await one(DB, 'select * from fin_lancamento where id=?', Number(m[1]));
          if (!l) return json(req, { erro: 'Lançamento não encontrado' }, 404);
          if (m[2] === 'aprovar') { if (!usuario.admin) return json(req, { erro: 'Só administrador aprova pagamento' }, 403); await DB.prepare('update fin_lancamento set aprovado=1 where id=?').bind(l.id).run(); return json(req, { ok: true }); }
          if (m[2] === 'quitar') {
            if (l.status !== 'aberto') return json(req, { erro: 'Esse lançamento não está em aberto' }, 400);
            if (l.tipo === 'P' && !l.aprovado) return json(req, { erro: 'Esse pagamento ainda não foi aprovado por um administrador' }, 400);
            const v = body.valor === undefined || body.valor === '' ? num(l.valor - l.pago) : num(body.valor), d = dataOk(body.data) ? body.data : (await one(DB, `select ${HOJE} d`)).d;
            if (!(v > 0) || v > num(l.valor - l.pago) + 0.005) return json(req, { erro: `Valor tem que ser entre 0 e ${num(l.valor - l.pago)}` }, 400);
            const conta = Number(body.conta_id) || l.conta_id; if (!conta) return json(req, { erro: 'Escolha a conta' }, 400);
            const pago = num(l.pago + v);
            await DB.prepare('update fin_lancamento set pago=?, quitacao=?, conta_id=?, status=? where id=?').bind(pago, d, conta, pago >= l.valor - 0.005 ? 'quitado' : 'aberto', l.id).run();
            return json(req, { ok: true });
          }
          if (m[2] === 'estornar') { await DB.prepare("update fin_lancamento set pago=0, quitacao=null, status='aberto' where id=?").bind(l.id).run(); return json(req, { ok: true }); }
          if (m[2] === 'cancelar') { await DB.prepare("update fin_lancamento set status='cancelado' where id=?").bind(l.id).run(); return json(req, { ok: true }); }
          if (m[2] === 'reativar') { await DB.prepare('update fin_lancamento set status=? where id=?').bind(l.pago >= l.valor - 0.005 ? 'quitado' : 'aberto', l.id).run(); return json(req, { ok: true }); }
          // editar
          if (body.pedido_numero !== undefined) { const pn = String(body.pedido_numero || '').trim(); if (pn) { const pd = await one(DB, 'select id from pedido where numero=?', pn); if (!pd) return json(req, { erro: 'Pedido ' + pn + ' não encontrado' }, 400); l.pedido_id = pd.id; } else l.pedido_id = null; }
          const x = await ids(), valor = body.valor === undefined ? l.valor : num(body.valor);
          if (!(valor > 0)) return json(req, { erro: 'Coloque o valor' }, 400);
          if (valor < l.pago - 0.005) return json(req, { erro: 'O valor não pode ser menor que o que já foi pago' }, 400);
          const venc = dataOk(body.vencimento) ? body.vencimento : l.vencimento;
          await DB.prepare(`update fin_lancamento set descricao=?, obs=?, pessoa=?, conta_id=?, conta_destino_id=?, categoria_id=?, centro_id=?, metodo=?, valor=?, vencimento=?, competencia=?, nf=?, pedido_id=?, status=? where id=?`)
            .bind(String(body.descricao ?? l.descricao).trim() || l.descricao, String(body.obs ?? l.obs ?? '').trim() || null, String(body.pessoa ?? l.pessoa ?? '').trim() || null,
              body.conta_id === undefined ? l.conta_id : x.conta, l.tipo === 'T' ? (body.conta_destino_id === undefined ? l.conta_destino_id : x.destino) : null,
              body.categoria_id === undefined ? l.categoria_id : x.cat, body.centro_id === undefined ? l.centro_id : x.centro, String(body.metodo ?? l.metodo ?? '').trim() || null,
              valor, venc, dataOk(body.competencia) ? body.competencia : l.competencia, String(body.nf ?? l.nf ?? '').trim() || null, l.pedido_id || null,
              l.status === 'cancelado' ? 'cancelado' : (l.pago >= valor - 0.005 ? 'quitado' : 'aberto'), l.id).run();
          return json(req, { ok: true });
        }
        if (p === '/api/fin/fluxo') {
          const hoje = (await one(DB, `select ${HOJE} d`)).d;
          const de = dataOk(q('de')) ? q('de') : hoje.slice(0, 8) + '01', ate = dataOk(q('ate')) ? q('ate') : new Date(Date.parse(hoje + 'T12:00:00Z') + 90 * 864e5).toISOString().slice(0, 10);
          const g = q('agrupar') === 'mes' ? 'substr(%s,1,7)' : q('agrupar') === 'semana' ? "date(%s, '-'||((cast(strftime('%w',%s) as int)+6)%7)||' days')" : '%s';
          const G = c => g.replaceAll('%s', c);
          const [real, prev, venc, cs] = await Promise.all([
            all(DB, `select ${G('quitacao')} per, round(sum(case when tipo='R' then pago end),2) entrou, round(sum(case when tipo='P' then pago end),2) saiu from fin_lancamento
              where tipo in ('P','R') and status!='cancelado' and pago>0 and quitacao between ? and ? group by per`, de, ate),
            all(DB, `select ${G('vencimento')} per, round(sum(case when tipo='R' then valor-pago end),2) a_receber, round(sum(case when tipo='P' then valor-pago end),2) a_pagar from fin_lancamento
              where tipo in ('P','R') and status='aberto' and vencimento >= ? and vencimento between ? and ? group by per`, hoje, de, ate),
            one(DB, `select round(sum(case when tipo='R' then valor-pago end),2) receber, round(sum(case when tipo='P' then valor-pago end),2) pagar from fin_lancamento where tipo in ('P','R') and status='aberto' and vencimento < ?`, hoje),
            contas()]);
          const M = {}; real.forEach(r => M[r.per] = { per: r.per, entrou: r.entrou || 0, saiu: r.saiu || 0, a_receber: 0, a_pagar: 0 });
          prev.forEach(r => { const o = M[r.per] = M[r.per] || { per: r.per, entrou: 0, saiu: 0 }; o.a_receber = r.a_receber || 0; o.a_pagar = r.a_pagar || 0; });
          const saldo = num(cs.filter(c => c.ativo).reduce((a, c) => a + c.saldo, 0));
          let proj = saldo; const linhas = Object.values(M).sort((a, b) => a.per < b.per ? -1 : 1).map(r => { proj = num(proj + r.a_receber - r.a_pagar); return { ...r, saldo_previsto: proj }; });
          return json(req, { de, ate, hoje, saldo, vencidos: { receber: num(venc.receber), pagar: num(venc.pagar) }, linhas });
        }
        if (p === '/api/fin/dre') {
          const ano = /^\d{4}$/.test(q('ano')) ? q('ano') : (await one(DB, `select substr(${HOJE},1,4) a`)).a;
          const rows = await all(DB, `select coalesce(ca.grupo_dre, case when l.tipo='R' then 'Receita (sem grupo)' else 'Despesa (sem grupo)' end) grupo, coalesce(ca.nome,'(sem categoria)') categoria, l.tipo,
              cast(substr(coalesce(l.competencia,l.vencimento),6,2) as int) mes, round(sum(l.valor),2) total
            from fin_lancamento l left join fin_categoria ca on ca.id=l.categoria_id
            where l.tipo in ('P','R') and l.status!='cancelado' and substr(coalesce(l.competencia,l.vencimento),1,4)=? group by 1,2,3,4`, ano);
          return json(req, { ano, linhas: rows });
        }
        if ((m = p.match(/^\/api\/fin\/(contas|categorias|centros)$/)) && req.method === 'POST') {
          const t = { contas: 'fin_conta', categorias: 'fin_categoria', centros: 'fin_centro' }[m[1]], nome = String(body.nome || '').trim(), id = Number(body.id) || null;
          if (!nome) return json(req, { erro: 'Coloque o nome' }, 400);
          const ativo = body.ativo === undefined ? 1 : (body.ativo ? 1 : 0);
          try {
            if (t === 'fin_conta') await (id ? DB.prepare('update fin_conta set nome=?, tipo=?, saldo_inicial=?, ativo=? where id=?').bind(nome, body.tipo || null, num(body.saldo_inicial), ativo, id)
              : DB.prepare('insert into fin_conta(nome, tipo, saldo_inicial, ativo) values(?,?,?,?)').bind(nome, body.tipo || null, num(body.saldo_inicial), ativo)).run();
            else if (t === 'fin_categoria') { if (!['D', 'R'].includes(body.tipo)) return json(req, { erro: 'Despesa ou receita?' }, 400);
              await (id ? DB.prepare('update fin_categoria set nome=?, tipo=?, grupo_dre=?, ativo=? where id=?').bind(nome, body.tipo, body.grupo_dre || null, ativo, id)
                : DB.prepare('insert into fin_categoria(nome, tipo, grupo_dre, ativo) values(?,?,?,?)').bind(nome, body.tipo, body.grupo_dre || null, ativo)).run(); }
            else await (id ? DB.prepare('update fin_centro set nome=?, ativo=? where id=?').bind(nome, ativo, id) : DB.prepare('insert into fin_centro(nome, ativo) values(?,?)').bind(nome, ativo)).run();
          } catch (e) { return json(req, { erro: String(e.message).includes('UNIQUE') ? 'Já existe um com esse nome' : e.message }, 400); }
          return json(req, { ok: true });
        }
        // importação do Sensio (só admin): cadastros, lançamentos (pelo id do Sensio) e acerto do saldo das contas
        if (p === '/api/fin/importar' && req.method === 'POST') {
          if (!usuario.admin) return json(req, { erro: 'Só o administrador' }, 403);
          const st = [];
          for (const c of body.categorias || []) st.push(DB.prepare('insert into fin_categoria(nome, tipo, grupo_dre, plano) values(?,?,?,?) on conflict(nome, tipo) do update set grupo_dre=excluded.grupo_dre, plano=excluded.plano').bind(c.nome, c.tipo, c.grupo_dre || null, c.plano || null));
          for (const n of body.centros || []) st.push(DB.prepare('insert or ignore into fin_centro(nome) values(?)').bind(n));
          for (const c of body.contas || []) st.push(DB.prepare('insert or ignore into fin_conta(nome, tipo) values(?,?)').bind(c.nome, c.tipo || null));
          if (st.length) await DB.batch(st);
          const L = body.lancamentos || [];
          if (L.length) {
            const [cs, cats, cens] = await Promise.all([all(DB, 'select id, nome from fin_conta'), all(DB, 'select id, nome, tipo from fin_categoria'), all(DB, 'select id, nome from fin_centro')]);
            const C = Object.fromEntries(cs.map(x => [x.nome, x.id])), CE = Object.fromEntries(cens.map(x => [x.nome, x.id])), CA = {}; cats.forEach(x => CA[x.tipo + '|' + x.nome] = x.id);
            const novasCat = [...new Set(L.filter(l => l.categoria && !CA[(l.tipo === 'R' ? 'R' : 'D') + '|' + l.categoria] && !(l.tipo === 'T' && (CA['R|' + l.categoria] || CA['D|' + l.categoria]))).map(l => (l.tipo === 'R' ? 'R' : 'D') + '|' + l.categoria))];
            if (novasCat.length) { await DB.batch(novasCat.map(k => DB.prepare('insert or ignore into fin_categoria(nome, tipo) values(?,?)').bind(k.slice(2), k[0])));
              (await all(DB, 'select id, nome, tipo from fin_categoria')).forEach(x => CA[x.tipo + '|' + x.nome] = x.id); }
            const cat = l => !l.categoria ? null : CA[(l.tipo === 'R' ? 'R' : 'D') + '|' + l.categoria] || CA['R|' + l.categoria] || CA['D|' + l.categoria] || null;
            await DB.batch(L.map(l => DB.prepare(`insert into fin_lancamento(tipo, descricao, obs, pessoa, conta_id, categoria_id, centro_id, metodo, valor, pago, vencimento, competencia, quitacao, parcela, nf, status, origem, sensio_id)
              values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'sensio',?) on conflict(sensio_id) do update set tipo=excluded.tipo, descricao=excluded.descricao, obs=excluded.obs, pessoa=excluded.pessoa, conta_id=excluded.conta_id,
              categoria_id=excluded.categoria_id, centro_id=excluded.centro_id, metodo=excluded.metodo, valor=excluded.valor, pago=excluded.pago, vencimento=excluded.vencimento, competencia=excluded.competencia,
              quitacao=excluded.quitacao, parcela=excluded.parcela, nf=excluded.nf, status=excluded.status`)
              .bind(l.tipo, l.descricao || '(sem descrição)', l.obs || null, l.pessoa || null, C[l.conta] || null, cat(l), CE[l.centro] || null, l.metodo || null, num(l.valor), num(l.pago), l.vencimento, l.competencia || null, l.quitacao || null, l.parcela || null, l.nf || null, l.status, l.sid)));
          }
          for (const c of body.calibrar || []) {
            const r = await one(DB, `select c.id, ${SALDO} - c.saldo_inicial mov from fin_conta c where c.nome=?`, c.nome);
            if (r) await DB.prepare('update fin_conta set saldo_inicial=? where id=?').bind(num(num(c.saldo) - r.mov), r.id).run();
          }
          await DB.prepare('insert into sync_log(origem, resumo) values(?,?)').bind('sensio-fin', JSON.stringify({ lancamentos: L.length, calibrar: (body.calibrar || []).length })).run().catch(() => {});
          return json(req, { ok: true, lancamentos: L.length });
        }
        // ---------- comprovantes (foto ou PDF) do lançamento
        if ((m = p.match(/^\/api\/fin\/lancamentos\/(\d+)\/anexos$/))) {
          const lid = Number(m[1]);
          if (req.method === 'GET') return json(req, await all(DB, 'select id, nome, tipo, length(dados) tam, criado_em, criado_nome from fin_anexo where lancamento_id=? order by id', lid));
          const d = String(body.dados || ''), tipo = d.startsWith('data:application/pdf;base64,') ? 'application/pdf' : d.startsWith('data:image/jpeg;base64,') ? 'image/jpeg' : null;
          if (!tipo) return json(req, { erro: 'Mande uma foto ou um PDF' }, 400);
          if (d.length > 1900000) return json(req, { erro: 'Arquivo grande demais (máx. ~1,3 MB). Tire uma foto ou reduza o PDF.' }, 400);
          if (!await one(DB, 'select id from fin_lancamento where id=?', lid)) return json(req, { erro: 'Lançamento não encontrado' }, 404);
          await DB.prepare('insert into fin_anexo(lancamento_id, nome, tipo, dados, criado_por, criado_nome) values(?,?,?,?,?,?)').bind(lid, String(body.nome || 'comprovante').slice(0, 120), tipo, d, usuario.id || null, usuario.nome || null).run();
          return json(req, { ok: true });
        }
        if ((m = p.match(/^\/api\/fin\/anexos\/(\d+)$/)) && req.method === 'GET') {
          const f = await one(DB, 'select nome, tipo, dados from fin_anexo where id=?', Number(m[1]));
          if (!f) return new Response('não achei', { status: 404, headers: cors(req) });
          const bin = Uint8Array.from(atob(f.dados.split(',')[1]), c => c.charCodeAt(0));
          return new Response(bin, { headers: { ...cors(req), 'Content-Type': f.tipo, 'Content-Disposition': `inline; filename="${encodeURIComponent(f.nome)}"`, 'Cache-Control': 'private, max-age=3600' } });
        }
        if ((m = p.match(/^\/api\/fin\/anexos\/(\d+)\/apagar$/)) && req.method === 'POST') {
          await DB.prepare('delete from fin_anexo where id=?').bind(Number(m[1])).run();
          return json(req, { ok: true });
        }
        // ---------- conciliação bancária: extrato OFX importado × lançamentos
        if (p === '/api/fin/extrato/importar' && req.method === 'POST') {
          const conta = Number(body.conta_id), T = Array.isArray(body.transacoes) ? body.transacoes : [];
          if (!await one(DB, 'select id from fin_conta where id=?', conta)) return json(req, { erro: 'Escolha a conta do extrato' }, 400);
          if (!T.length) return json(req, { erro: 'Não achei movimentos no arquivo' }, 400);
          const antes = (await one(DB, 'select count(*) n from fin_extrato where conta_id=?', conta)).n;
          await DB.batch(T.filter(t => dataOk(t.data) && Number(t.valor)).map(t => DB.prepare('insert or ignore into fin_extrato(conta_id, fitid, data, valor, descricao) values(?,?,?,?,?)')
            .bind(conta, String(t.fitid || (t.data + '|' + t.valor + '|' + (t.descricao || ''))), t.data, num(t.valor), String(t.descricao || '').slice(0, 200))));
          if (body.saldo !== undefined && body.saldo !== null && dataOk(body.saldo_data)) await DB.prepare('update fin_conta set extrato_saldo=?, extrato_data=? where id=?').bind(num(body.saldo), body.saldo_data, conta).run();
          // automático: movimento do extrato que bate com um lançamento já pago/recebido nessa conta (mesmo valor, até 3 dias de diferença)
          const pend = await all(DB, "select * from fin_extrato where conta_id=? and status='pendente'", conta);
          let auto = 0;
          for (const e of pend) {
            const l = await one(DB, `select id from fin_lancamento where conta_id=? and status='quitado' and tipo=? and abs(pago-?)<0.01 and abs(julianday(quitacao)-julianday(?))<=3
              and id not in (select lancamento_id from fin_extrato where lancamento_id is not null) order by abs(julianday(quitacao)-julianday(?)) limit 1`, conta, e.valor > 0 ? 'R' : 'P', Math.abs(e.valor), e.data, e.data);
            if (l) { await DB.prepare("update fin_extrato set lancamento_id=?, status='conciliado' where id=?").bind(l.id, e.id).run(); auto++; }
          }
          return json(req, { ok: true, novos: (await one(DB, 'select count(*) n from fin_extrato where conta_id=?', conta)).n - antes, auto });
        }
        if (p === '/api/fin/extrato' && req.method === 'GET') {
          const conta = Number(q('conta_id')), st = ['pendente', 'conciliado', 'ignorado'].includes(q('status')) ? q('status') : 'pendente';
          const [rows, c, cnt] = await Promise.all([
            all(DB, `select e.*, l.descricao l_descricao, l.pessoa l_pessoa from fin_extrato e left join fin_lancamento l on l.id=e.lancamento_id where e.conta_id=? and e.status=? order by e.data desc, e.id desc limit 500`, conta, st),
            one(DB, `select c.*, round(${SALDO}, 2) saldo from fin_conta c where c.id=?`, conta),
            all(DB, 'select status, count(*) n from fin_extrato where conta_id=? group by status', conta)]);
          if (st === 'pendente') for (const e of rows)
            e.sugestoes = await all(DB, `select id, descricao, pessoa, vencimento, status, round(valor-pago,2) aberto, conta_id from fin_lancamento
              where tipo=? and status='aberto' and abs((valor-pago)-?)<0.01 and abs(julianday(vencimento)-julianday(?))<=20
              and id not in (select lancamento_id from fin_extrato where lancamento_id is not null) order by (conta_id=?) desc, abs(julianday(vencimento)-julianday(?)) limit 3`,
              e.valor > 0 ? 'R' : 'P', Math.abs(e.valor), e.data, conta, e.data);
          return json(req, { conta: c, contagem: Object.fromEntries(cnt.map(x => [x.status, x.n])), lista: rows });
        }
        if ((m = p.match(/^\/api\/fin\/extrato\/(\d+)$/)) && req.method === 'POST') {
          const e = await one(DB, 'select * from fin_extrato where id=?', Number(m[1]));
          if (!e) return json(req, { erro: 'Movimento não encontrado' }, 404);
          if (body.acao === 'ignorar') { await DB.prepare("update fin_extrato set status='ignorado', lancamento_id=null where id=?").bind(e.id).run(); return json(req, { ok: true }); }
          if (body.acao === 'desfazer') { await DB.prepare("update fin_extrato set status='pendente', lancamento_id=null where id=?").bind(e.id).run(); return json(req, { ok: true }); }
          const tipo = e.valor > 0 ? 'R' : 'P', v = Math.abs(e.valor);
          if (body.acao === 'conciliar') {
            const l = await one(DB, 'select * from fin_lancamento where id=?', Number(body.lancamento_id));
            if (!l || l.tipo !== tipo) return json(req, { erro: 'Lançamento não serve pra esse movimento' }, 400);
            if (l.status === 'aberto') { const pago = num(l.pago + Math.min(v, l.valor - l.pago));
              await DB.prepare('update fin_lancamento set pago=?, quitacao=?, conta_id=?, aprovado=1, status=? where id=?').bind(pago, e.data, e.conta_id, pago >= l.valor - 0.005 ? 'quitado' : 'aberto', l.id).run(); }
            await DB.prepare("update fin_extrato set lancamento_id=?, status='conciliado' where id=?").bind(l.id, e.id).run();
            return json(req, { ok: true });
          }
          if (body.acao === 'criar') {
            const r = await DB.prepare(`insert into fin_lancamento(tipo, descricao, pessoa, conta_id, categoria_id, centro_id, valor, pago, vencimento, competencia, quitacao, status, aprovado, criado_por, obs)
              values(?,?,?,?,?,?,?,?,?,?,?,'quitado',1,?,?)`).bind(tipo, String(body.descricao || e.descricao || 'Movimento do extrato').trim(), String(body.pessoa || '').trim() || null, e.conta_id,
              Number(body.categoria_id) || null, Number(body.centro_id) || null, v, v, e.data, e.data, e.data, usuario.id || null, 'Criado pela conciliação do extrato').run();
            await DB.prepare("update fin_extrato set lancamento_id=?, status='conciliado' where id=?").bind(r.meta.last_row_id, e.id).run();
            return json(req, { ok: true });
          }
          return json(req, { erro: 'Ação inválida' }, 400);
        }
        // ---------- cobrança: vencidos a receber por cliente, faixas de atraso, contatos e promessas
        if (p === '/api/fin/cobranca' && req.method === 'GET') {
          const [ls, cont] = await Promise.all([
            all(DB, `select l.id, l.descricao, l.pessoa, l.vencimento, l.nf, l.parcela, l.pedido_id, round(l.valor-l.pago,2) aberto, cast(julianday(${HOJE})-julianday(l.vencimento) as int) dias,
                (select numero from pedido where id=l.pedido_id) pedido from fin_lancamento l where l.tipo='R' and l.status='aberto' and l.vencimento < ${HOJE} order by l.vencimento`),
            all(DB, `select * from fin_cobranca order by criado_em desc, id desc`)]);
          const fx = d => d <= 30 ? 'a30' : d <= 60 ? 'a60' : d <= 90 ? 'a90' : 'mais', F = { a30: 0, a60: 0, a90: 0, mais: 0 }, C = {};
          for (const l of ls) {
            if (!l.pedido) { const mm = String(l.descricao || '').match(/pedido\s*(\d+)/i); if (mm) l.pedido = mm[1]; }
            const k = l.pessoa || '(sem cliente)', c = C[k] = C[k] || { pessoa: k, total: 0, n: 0, maior_atraso: 0, faixas: { a30: 0, a60: 0, a90: 0, mais: 0 }, lancs: [] };
            c.total = num(c.total + l.aberto); c.n++; c.maior_atraso = Math.max(c.maior_atraso, l.dias); c.faixas[fx(l.dias)] = num(c.faixas[fx(l.dias)] + l.aberto); c.lancs.push(l);
            F[fx(l.dias)] = num(F[fx(l.dias)] + l.aberto);
          }
          const hoje = (await one(DB, `select ${HOJE} d`)).d;
          for (const c of Object.values(C)) {
            const h = cont.filter(x => x.pessoa === c.pessoa);
            c.ultimo = h[0] || null; c.contatos = h.length;
            const pr = h.find(x => x.promessa_data); c.promessa = pr ? { data: pr.promessa_data, texto: pr.texto, vencida: pr.promessa_data < hoje, hoje: pr.promessa_data === hoje } : null;
          }
          const clientes = Object.values(C).sort((a, b) => b.total - a.total);
          return json(req, { hoje, faixas: F, total: num(Object.values(F).reduce((a, b) => a + b, 0)), clientes, promessas: clientes.filter(c => c.promessa && c.promessa.data <= hoje).map(c => ({ pessoa: c.pessoa, total: c.total, ...c.promessa })) });
        }
        if (p === '/api/fin/cobranca/historico') {
          return json(req, await all(DB, 'select * from fin_cobranca where pessoa=? order by criado_em desc, id desc', q('pessoa')));
        }
        if (p === '/api/fin/cobranca' && req.method === 'POST') {
          const pessoa = String(body.pessoa || '').trim(), tipo = String(body.tipo || '').trim();
          if (!pessoa) return json(req, { erro: 'Falta o cliente' }, 400);
          if (!['ligacao', 'whatsapp', 'email', 'mensagem', 'visita', 'outro'].includes(tipo)) return json(req, { erro: 'Escolha como foi o contato' }, 400);
          if (body.promessa_data && !dataOk(body.promessa_data)) return json(req, { erro: 'Data da promessa inválida' }, 400);
          await DB.prepare('insert into fin_cobranca(pessoa, lancamento_id, tipo, texto, promessa_data, criado_por, criado_nome) values(?,?,?,?,?,?,?)')
            .bind(pessoa, Number(body.lancamento_id) || null, tipo, String(body.texto || '').trim() || null, body.promessa_data || null, usuario.id || null, usuario.nome || null).run();
          return json(req, { ok: true });
        }
        // financeiro de um pedido: lançamentos a receber ligados (pelo pedido, pela descrição "Pedido N" ou pela NF de um envio do pedido)
        if ((m = p.match(/^\/api\/fin\/pedido\/([^/]+)$/))) {
          const ped = await one(DB, 'select id, numero, cliente from pedido where numero=?', decodeURIComponent(m[1]));
          if (!ped) return json(req, { erro: 'Pedido não encontrado' }, 404);
          return json(req, { pedido: ped, ...(await finDoPedido(DB, ped)) });
        }
        return json(req, { erro: 'Rota do financeiro não encontrada' }, 404);
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
