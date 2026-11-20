// OMAMA Produção – servidor (Cloudflare Worker + banco D1 ligado como "DB")
// Segredo necessário: CODIGO (código de acesso do líder/admin)

const ORIGENS = ['https://expedicao-star.github.io'];

function cors(req) {
  const o = req.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': ORIGENS.includes(o) || o.startsWith('http://localhost') ? o : ORIGENS[0],
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Codigo',
    'Vary': 'Origin',
  };
}
const json = (req, data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(req) } });

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(req) });
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === '/') return json(req, { ok: true, sistema: 'OMAMA Produção' });

    if ((req.headers.get('X-Codigo') || '') !== env.CODIGO) return json(req, { erro: 'Código de acesso inválido' }, 401);
    const DB = env.DB;
    try {
      // ---- Cadastros
      if (p === '/api/cadastros' && req.method === 'GET') {
        const [setores, etapas, funcionarios, produtos, roteiro, madeiras, pedidos] = await Promise.all([
          DB.prepare('select * from setor order by id').all(),
          DB.prepare('select * from etapa order by ordem').all(),
          DB.prepare('select * from funcionario where ativo=1 order by nome').all(),
          DB.prepare('select * from produto where ativo=1 order by linha, nome').all(),
          DB.prepare('select * from roteiro').all(),
          DB.prepare('select * from madeira order by nome').all(),
          DB.prepare("select p.id, p.numero, c.nome cliente from pedido p left join cliente c on c.id=p.cliente_id where p.status not in ('expedido','cancelado') order by p.numero").all(),
        ]);
        return json(req, {
          setores: setores.results, etapas: etapas.results, funcionarios: funcionarios.results,
          produtos: produtos.results, roteiro: roteiro.results, madeiras: madeiras.results, pedidos: pedidos.results,
        });
      }
      if (p === '/api/funcionarios' && req.method === 'POST') {
        const b = await req.json();
        if (!b.nome) return json(req, { erro: 'Nome obrigatório' }, 400);
        const r = await DB.prepare('insert into funcionario(nome, setor_id) values(?,?)').bind(b.nome.trim(), b.setor_id || null).run();
        return json(req, { ok: true, id: r.meta.last_row_id });
      }
      if (p === '/api/meta' && req.method === 'POST') {
        const b = await req.json();
        await DB.prepare('insert into roteiro(produto_id, etapa_id, meta_dia_pessoa) values(?,?,?) on conflict(produto_id, etapa_id) do update set meta_dia_pessoa=excluded.meta_dia_pessoa')
          .bind(b.produto_id, b.etapa_id, b.meta).run();
        return json(req, { ok: true });
      }

      // ---- Apontamentos
      if (p === '/api/apontamentos' && req.method === 'GET') {
        const data = url.searchParams.get('data');
        const r = await DB.prepare(`select a.*, f.nome funcionario, e.nome etapa, pr.nome produto, pe.numero pedido
          from apontamento a join funcionario f on f.id=a.funcionario_id join etapa e on e.id=a.etapa_id
          join produto pr on pr.id=a.produto_id left join pedido pe on pe.id=a.pedido_id
          where a.data=? order by a.id desc`).bind(data).all();
        return json(req, r.results);
      }
      if (p === '/api/apontamentos' && req.method === 'POST') {
        const b = await req.json();
        const itens = Array.isArray(b) ? b : [b];
        const stmts = itens.map(i => {
          if (!i.data || !i.funcionario_id || !i.etapa_id || !i.produto_id || !(i.qtd > 0)) throw new Error('Preencha data, funcionário, setor, produto e quantidade');
          return DB.prepare('insert into apontamento(data, funcionario_id, etapa_id, produto_id, pedido_id, qtd, lancado_por, obs) values(?,?,?,?,?,?,?,?)')
            .bind(i.data, i.funcionario_id, i.etapa_id, i.produto_id, i.pedido_id || null, i.qtd, i.lancado_por || null, i.obs || null);
        });
        await DB.batch(stmts);
        return json(req, { ok: true, gravados: stmts.length });
      }
      if (p.startsWith('/api/apontamentos/') && req.method === 'DELETE') {
        await DB.prepare('delete from apontamento where id=?').bind(Number(p.split('/').pop())).run();
        return json(req, { ok: true });
      }

      // ---- Presença (falta)
      if (p === '/api/presenca' && req.method === 'GET') {
        const r = await DB.prepare('select * from presenca where data=?').bind(url.searchParams.get('data')).all();
        return json(req, r.results);
      }
      if (p === '/api/presenca' && req.method === 'POST') {
        const b = await req.json();
        await DB.prepare('insert into presenca(data, funcionario_id, falta) values(?,?,?) on conflict(data, funcionario_id) do update set falta=excluded.falta')
          .bind(b.data, b.funcionario_id, b.falta ? 1 : 0).run();
        return json(req, { ok: true });
      }

      // ---- Painel meta x realizado
      // Cada peça vale 1/meta de um dia. Eficiência = soma(qtd/meta) ÷ dias com lançamento.
      if (p === '/api/painel' && req.method === 'GET') {
        const de = url.searchParams.get('de'), ate = url.searchParams.get('ate');
        const r = await DB.prepare(`select f.id, f.nome funcionario, s.nome setor,
            sum(a.qtd) pecas,
            sum(case when r.meta_dia_pessoa>0 then a.qtd*1.0/r.meta_dia_pessoa else 0 end) dias_meta,
            count(distinct a.data) dias,
            sum(case when r.meta_dia_pessoa is null then a.qtd else 0 end) sem_meta
          from apontamento a join funcionario f on f.id=a.funcionario_id
          join etapa e on e.id=a.etapa_id join setor s on s.id=e.setor_id
          left join roteiro r on r.produto_id=a.produto_id and r.etapa_id=a.etapa_id
          where a.data between ? and ?
          group by f.id, s.id order by s.id, f.nome`).bind(de, ate).all();
        const det = await DB.prepare(`select a.data, f.nome funcionario, e.nome etapa, pr.nome produto, sum(a.qtd) qtd, r.meta_dia_pessoa meta
          from apontamento a join funcionario f on f.id=a.funcionario_id join etapa e on e.id=a.etapa_id
          join produto pr on pr.id=a.produto_id left join roteiro r on r.produto_id=a.produto_id and r.etapa_id=a.etapa_id
          where a.data between ? and ? group by a.data, f.id, e.id, pr.id order by a.data desc, f.nome`).bind(de, ate).all();
        return json(req, { resumo: r.results, detalhe: det.results });
      }

      return json(req, { erro: 'Rota não encontrada' }, 404);
    } catch (e) {
      return json(req, { erro: e.message }, 400);
    }
  },
};
