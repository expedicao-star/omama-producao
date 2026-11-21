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
const ESTAGIO_INICIAL = 1, ESTAGIO_FINAL = 12, DEP_PA = 1, DEP_PATIO = 11;

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
      i.id item_id, i.codigo item_codigo, i.nome item_nome,
      (select t.nome || '|' || oo.status || '|' || coalesce(f.nome,'') from op_operacao oo join operacao_tipo t on t.id=oo.operacao_tipo_id
         left join funcionario f on f.id=oo.funcionario_id where oo.op_id=op.id and oo.status<>'finalizado' order by oo.ordem limit 1) atual
    from op join item i on i.id=op.item_id where ${where} order by op.previsao_fim is null, op.previsao_fim, op.codigo`, ...b);
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
      if (p === '/api/funcionarios' && req.method === 'POST') {
        if (!body.nome) return json(req, { erro: 'Nome obrigatório' }, 400);
        await DB.prepare('insert into funcionario(nome, setor_id) values(?,?)').bind(body.nome.trim(), body.setor_id || null).run();
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
        const max = await one(DB, 'select max(codigo) m from op where origem is null');
        const codigo = Math.max(5000, (max && max.m) || 0) + 1;
        await DB.prepare('insert into op(codigo, item_id, qtd, previsao_inicio, previsao_fim, estagio_id, pedido, obs) values(?,?,?,?,?,?,?,?)')
          .bind(codigo, item.id, body.qtd, body.previsao_inicio || agora().slice(0, 10), body.previsao_fim || null, ESTAGIO_INICIAL, body.pedido || null, body.obs || null).run();
        const op = await one(DB, 'select id from op where codigo=?', codigo);
        const comps = await all(DB, 'select c.insumo_id, c.qtd, i.nome from composicao c join item i on i.id=c.insumo_id where c.item_id=?', item.id);
        await DB.batch([
          ...comps.map(c => DB.prepare('insert into estoque_mov(item_id, deposito_id, qtd, motivo, op_id) values(?,?,?,?,?)')
            .bind(c.insumo_id, DEP_PATIO, -(c.qtd * body.qtd), 'Baixa na criação da OP ' + codigo, op.id)),
          ...(comps.length ? [evento(DB, op.id, 'Blocos baixados do Pátio: ' + comps.map(c => `${+(c.qtd * body.qtd).toFixed(3)} × ${c.nome}`).join(', '))] : []),
          ...rot.map(r => DB.prepare('insert into op_operacao(op_id, ordem, operacao_tipo_id, tempo_unit_min) values(?,?,?,?)').bind(op.id, r.ordem, r.operacao_tipo_id, r.tempo_min)),
          evento(DB, op.id, `OP criada: ${body.qtd} × ${item.nome}` + (rot.length ? '' : ' (item sem roteiro)')),
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
          all(DB, 'select c.qtd, i.id, i.codigo, i.nome from composicao c join item i on i.id=c.insumo_id where c.item_id=?', item.id),
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
