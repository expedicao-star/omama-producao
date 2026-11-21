// OMAMA Produção v2 – servidor (Cloudflare Worker + D1 "DB"), no modelo do Sensio.
// Segredo: CODIGO (código de acesso do líder/admin).

const ORIGENS = ['https://expedicao-star.github.io'];
const cors = (req) => {
  const o = req.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': ORIGENS.includes(o) || o.startsWith('http://localhost') ? o : ORIGENS[0],
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Codigo',
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

const ESTAGIO_INICIAL = 1, ESTAGIO_FINAL = 12, DEP_PA = 1, DEP_PATIO = 11, DEP_RETRABALHO = 4, DEP_DEFEITO = 6;

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
  // todas as operações finalizadas: finaliza a OP e dá entrada no P.A. (os blocos já saíram na criação da OP)
  const st = [
    DB.prepare("update op set status='finalizada', estagio_id=?, finalizado_em=? where id=?").bind(ESTAGIO_FINAL, agora(), op_id),
    DB.prepare('insert into estoque_mov(item_id, deposito_id, qtd, motivo, op_id) values(?,?,?,?,?)').bind(op.item_id, DEP_PA, op.qtd, 'Entrada da OP ' + op.codigo, op_id),
    evento(DB, op_id, 'OP finalizada: entrada no P.A.'),
  ];
  await DB.batch(st);
}

async function opsAbertas(DB, where = "op.status='aberta'", ...b) {
  return all(DB, `select op.id, op.codigo, op.qtd, op.estagio_id, op.previsao_inicio, op.previsao_fim, op.pedido, op.status, op.origem,
      i.id item_id, i.codigo item_codigo, i.nome item_nome, op.pedido_item_id, pd.numero pedido_numero, pd.cliente pedido_cliente,
      (select t.nome || '|' || oo.status || '|' || coalesce(f.nome,'') from op_operacao oo join operacao_tipo t on t.id=oo.operacao_tipo_id
         left join funcionario f on f.id=oo.funcionario_id where oo.op_id=op.id and oo.status<>'finalizado' order by oo.ordem limit 1) atual
    from op join item i on i.id=op.item_id left join pedido_item pi on pi.id=op.pedido_item_id left join pedido pd on pd.id=pi.pedido_id where ${where} order by op.previsao_fim is null, op.previsao_fim, op.codigo`, ...b);
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(req) });
    const url = new URL(req.url), p = url.pathname, q = (k) => url.searchParams.get(k);
    if (p === '/') return json(req, { ok: true, sistema: 'OMAMA Produção', versao: 2 });
    if ((req.headers.get('X-Codigo') || '') !== env.CODIGO) return json(req, { erro: 'Código de acesso inválido' }, 401);
    const DB = env.DB;
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    let m;
    try {
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
        const sel = `select d.*, i.codigo, i.nome item, s.nome setor, f.nome funcionario, o.codigo op_codigo
          from defeito d join item i on i.id=d.item_id left join setor s on s.id=d.setor_id left join funcionario f on f.id=d.funcionario_id left join op o on o.id=d.op_id`;
        if (q('situacao') === 'todos') return json(req, await all(DB, sel + ' where d.data between ? and ? order by d.id desc limit 500', q('de'), q('ate') + ' 23:59:59'));
        return json(req, await all(DB, sel + " where d.situacao='em_defeito' order by d.id desc"));
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
        if (!d || d.situacao !== 'em_defeito') return json(req, { erro: 'Defeito já resolvido' }, 400);
        const acao = m[2], nomes = { recuperar: 'recuperado', retrabalho: 'retrabalho', descartar: 'descartado' };
        const mov = (dep, qtd, motivo) => DB.prepare('insert into estoque_mov(item_id, deposito_id, qtd, motivo, op_id) values(?,?,?,?,?)').bind(d.item_id, dep, qtd, motivo, d.op_id);
        const st = [DB.prepare('update defeito set situacao=?, resolvido_em=?, resolucao_obs=? where id=?').bind(nomes[acao], agora(), body.obs || null, d.id),
          mov(DEP_DEFEITO, -d.qtd, 'Defeito ' + nomes[acao])];
        if (acao === 'recuperar') st.push(mov(DEP_PA, d.qtd, 'Recuperada do defeito'));
        if (acao === 'retrabalho') st.push(mov(DEP_RETRABALHO, d.qtd, 'Veio do defeito'));
        await DB.batch(st);
        return json(req, { ok: true });
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
        const max = await one(DB, 'select max(codigo) m from op where origem is null');
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
          all(DB, `select oo.*, t.nome, t.setor_id, t.espera, t.estagio_id, f.nome funcionario from op_operacao oo
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
        await DB.batch([DB.prepare("update op set status='cancelada' where id=?").bind(op.id), evento(DB, op.id, 'OP cancelada' + (body.motivo ? ': ' + body.motivo : '') + (baixas.length ? ' (blocos devolvidos ao Pátio)' : '')),
          ...baixas.map(b => DB.prepare('insert into estoque_mov(item_id, deposito_id, qtd, motivo, op_id) values(?,?,?,?,?)').bind(b.item_id, DEP_PATIO, -b.q, 'Devolução do cancelamento da OP ' + op.codigo, op.id))]);
        return json(req, { ok: true });
      }

      // ---------- operações (iniciar / pausar / finalizar)
      if ((m = p.match(/^\/api\/operacoes\/(\d+)\/(iniciar|pausar|finalizar|reabrir)$/)) && req.method === 'POST') {
        const oo = await one(DB, `select oo.*, t.nome, t.setor_id, op.status op_status, op.codigo from op_operacao oo
          join operacao_tipo t on t.id=oo.operacao_tipo_id join op on op.id=oo.op_id where oo.id=?`, Number(m[1]));
        if (!oo || oo.op_status !== 'aberta') return json(req, { erro: 'Operação não encontrada ou OP fechada' }, 400);
        const acao = m[2], now = agora();
        const func = body.funcionario_id ? await one(DB, 'select * from funcionario where id=?', body.funcionario_id) : null;
        const quem = func ? func.nome : 'Líder';
        let upd;
        if (acao === 'iniciar') {
          if (!['pendente', 'pausado'].includes(oo.status)) return json(req, { erro: 'Operação já está ' + oo.status }, 400);
          if (oo.setor_id && !func && !oo.funcionario_id) return json(req, { erro: 'Escolha quem vai fazer' }, 400);
          upd = DB.prepare("update op_operacao set status='produzindo', funcionario_id=coalesce(?,funcionario_id), inicio=coalesce(inicio,?), inicio_atual=? where id=?")
            .bind(func ? func.id : null, now, now, oo.id);
        } else if (acao === 'pausar') {
          if (oo.status !== 'produzindo') return json(req, { erro: 'Só dá para pausar o que está produzindo' }, 400);
          upd = DB.prepare("update op_operacao set status='pausado', minutos=minutos+?, inicio_atual=null where id=?").bind(minDesde(oo.inicio_atual), oo.id);
        } else if (acao === 'finalizar') {
          if (oo.status === 'finalizado') return json(req, { erro: 'Já finalizada' }, 400);
          if (oo.setor_id && !func && !oo.funcionario_id) return json(req, { erro: 'Escolha quem fez' }, 400);
          const extra = oo.status === 'produzindo' ? minDesde(oo.inicio_atual) : 0;
          upd = DB.prepare("update op_operacao set status='finalizado', funcionario_id=coalesce(?,funcionario_id), minutos=minutos+?, inicio=coalesce(inicio,?), fim=?, inicio_atual=null where id=?")
            .bind(func ? func.id : null, extra, now, now, oo.id);
        } else {
          if (oo.status !== 'finalizado') return json(req, { erro: 'Só reabre operação finalizada' }, 400);
          upd = DB.prepare("update op_operacao set status='pausado', fim=null where id=?").bind(oo.id);
        }
        const verbo = { iniciar: 'iniciou', pausar: 'pausou', finalizar: 'finalizou', reabrir: 'reabriu' }[acao];
        await DB.batch([upd, evento(DB, oo.op_id, `${quem} ${verbo} ${oo.nome}`)]);
        await recalcularOp(DB, oo.op_id);
        return json(req, { ok: true });
      }

      // fila do setor: operações prontas (a próxima de cada OP) + as que estão produzindo/pausadas
      if (p === '/api/fila') {
        const setor = Number(q('setor_id'));
        const r = await all(DB, `select oo.id, oo.status, oo.ordem, oo.tempo_unit_min, oo.minutos, oo.inicio_atual, t.nome operacao, t.setor_id,
            op.codigo, op.qtd, op.previsao_fim, i.nome item_nome, f.nome funcionario, oo.funcionario_id,
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
            (select coalesce(sum(qtd),0) from op where pedido_item_id=pi.id and status='aberta' and estagio_id<11) op_prod
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
          if (it.item_id) st.push(DB.prepare('insert into estoque_mov(item_id, deposito_id, qtd, motivo) values(?,?,?,?)').bind(it.item_id, DEP_PA, -l.qtd, `Envio do pedido ${pd.numero} (${pd.cliente || ''})`));
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
        return json(req, await all(DB, `select i.id, i.codigo, i.nome, i.tipo, sum(m.qtd) saldo from estoque_mov m join item i on i.id=m.item_id
          where m.deposito_id=? group by i.id having abs(saldo)>0.0001 order by i.codigo`, Number(q('deposito_id') || DEP_PATIO)));
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

      // ---------- relatório de produção (operações finalizadas no período)
      if (p === '/api/relatorio') {
        const de = q('de') + ' 00:00:00', ate = q('ate') + ' 23:59:59';
        const porPessoa = await all(DB, `select f.id, f.nome funcionario, s.nome setor, count(*) operacoes, sum(op.qtd) pecas,
            sum(oo.minutos) minutos_reais, sum(oo.tempo_unit_min*op.qtd) minutos_padrao,
            sum(case when oo.minutos>=1 then oo.tempo_unit_min*op.qtd else 0 end) padrao_medido,
            sum(case when oo.minutos>=1 then oo.minutos else 0 end) minutos_medidos
          from op_operacao oo join op on op.id=oo.op_id join operacao_tipo t on t.id=oo.operacao_tipo_id
          join funcionario f on f.id=oo.funcionario_id left join setor s on s.id=f.setor_id
          where oo.status='finalizado' and t.espera=0 and oo.fim between ? and ? group by f.id order by s.id, f.nome`, de, ate);
        const detalhe = await all(DB, `select oo.fim, f.nome funcionario, t.nome operacao, op.codigo, i.nome item, op.qtd, oo.minutos, oo.tempo_unit_min*op.qtd padrao
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
