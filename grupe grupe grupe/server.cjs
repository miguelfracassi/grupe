// ===========================================================
// Grupo Ticord — servidor do site
// Não usa nenhuma dependência externa (só módulos nativos do Node),
// então funciona com "node server.js" sem precisar de "npm install".
// ===========================================================

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORTA = process.env.PORTA || process.env.PORT || 3000;

// Troque essa senha antes de colocar o site no ar de verdade.
// Também pode ser definida pela variável de ambiente ADMIN_SENHA.
const ADMIN_SENHA = process.env.ADMIN_SENHA || 'ticord123';

const PASTA_PUBLICA = path.join(__dirname, 'public');
const ARQUIVO_DADOS = path.join(__dirname, 'data', 'envios.json');

const TIPOS_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

// ---------- utilidades de dados ----------

function garantirArquivoDados() {
  if (!fs.existsSync(path.dirname(ARQUIVO_DADOS))) {
    fs.mkdirSync(path.dirname(ARQUIVO_DADOS), { recursive: true });
  }
  if (!fs.existsSync(ARQUIVO_DADOS)) {
    fs.writeFileSync(ARQUIVO_DADOS, '[]', 'utf-8');
  }
}

function lerEnvios() {
  garantirArquivoDados();
  try {
    const conteudo = fs.readFileSync(ARQUIVO_DADOS, 'utf-8');
    return JSON.parse(conteudo);
  } catch (erro) {
    return [];
  }
}

function salvarEnvios(envios) {
  garantirArquivoDados();
  fs.writeFileSync(ARQUIVO_DADOS, JSON.stringify(envios, null, 2), 'utf-8');
}

function textoValido(valor, tamanhoMaximo = 2000) {
  return typeof valor === 'string' && valor.trim().length > 0 && valor.length <= tamanhoMaximo;
}

// ---------- utilidades http ----------

function enviarJson(res, status, dados) {
  const corpo = JSON.stringify(dados);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(corpo),
  });
  res.end(corpo);
}

function lerCorpoJson(req) {
  return new Promise((resolve, reject) => {
    let dados = '';
    let tamanho = 0;
    const limite = 100 * 1024; // 100kb é mais que suficiente para o formulário

    req.on('data', (pedaco) => {
      tamanho += pedaco.length;
      if (tamanho > limite) {
        reject(new Error('Corpo da requisição muito grande'));
        req.destroy();
        return;
      }
      dados += pedaco;
    });

    req.on('end', () => {
      try {
        resolve(dados ? JSON.parse(dados) : {});
      } catch (erro) {
        reject(erro);
      }
    });

    req.on('error', reject);
  });
}

function autenticado(req) {
  const senhaEnviada = req.headers['x-admin-senha'] || '';
  return senhaEnviada === ADMIN_SENHA;
}

function servir404(res) {
  fs.readFile(path.join(PASTA_PUBLICA, '404.html'), (erro404, conteudo404) => {
    if (erro404) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Página não encontrada');
    } else {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(conteudo404);
    }
  });
}

function enviarArquivo(res, caminhoAbsoluto) {
  fs.readFile(caminhoAbsoluto, (erro, conteudo) => {
    if (erro) {
      servir404(res);
      return;
    }
    const extensao = path.extname(caminhoAbsoluto).toLowerCase();
    res.writeHead(200, { 'Content-Type': TIPOS_MIME[extensao] || 'application/octet-stream' });
    res.end(conteudo);
  });
}

function servirArquivoEstatico(req, res) {
  let caminhoRelativo = decodeURIComponent(req.url.split('?')[0]);

  // Se alguém acessar algo terminando em ".html", redireciona pra
  // versão sem extensão (URL sempre "limpa", nunca mostra .html).
  if (caminhoRelativo.endsWith('.html')) {
    let destino = caminhoRelativo.slice(0, -'.html'.length);
    if (destino === '/index' || destino === '') destino = '/';
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.writeHead(301, { Location: destino + query });
    res.end();
    return;
  }

  if (caminhoRelativo === '/') caminhoRelativo = '/index.html';

  const caminhoAbsoluto = path.normalize(path.join(PASTA_PUBLICA, caminhoRelativo));

  // Evita sair da pasta public
  if (!caminhoAbsoluto.startsWith(PASTA_PUBLICA)) {
    res.writeHead(403);
    res.end('Acesso negado');
    return;
  }

  fs.readFile(caminhoAbsoluto, (erro, conteudo) => {
    if (!erro) {
      const extensao = path.extname(caminhoAbsoluto).toLowerCase();
      res.writeHead(200, { 'Content-Type': TIPOS_MIME[extensao] || 'application/octet-stream' });
      res.end(conteudo);
      return;
    }

    // Não achou o arquivo exato. Se o link não tem ponto (ex: /cord),
    // tenta de novo colocando ".html" no final (ex: /cord.html).
    if (!path.extname(caminhoAbsoluto)) {
      const comHtml = caminhoAbsoluto + '.html';
      if (comHtml.startsWith(PASTA_PUBLICA)) {
        fs.readFile(comHtml, (erro2, conteudo2) => {
          if (erro2) {
            servir404(res);
            return;
          }
          res.writeHead(200, { 'Content-Type': TIPOS_MIME['.html'] });
          res.end(conteudo2);
        });
        return;
      }
    }

    servir404(res);
  });
}

// ---------- rotas da API ----------

async function tratarEnviarFormulario(req, res) {
  let corpo;
  try {
    corpo = await lerCorpoJson(req);
  } catch (erro) {
    enviarJson(res, 400, { erro: 'JSON inválido' });
    return;
  }

  const { nome, email, telefone, discord, motivo, mensagem } = corpo;

  if (![nome, email, telefone, discord, motivo, mensagem].every((campo) => textoValido(campo))) {
    enviarJson(res, 400, { erro: 'Preencha todos os campos corretamente.' });
    return;
  }

  const regexEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!regexEmail.test(email.trim())) {
    enviarJson(res, 400, { erro: 'Informe um e-mail válido.' });
    return;
  }

  const envios = lerEnvios();
  const novoEnvio = {
    id: crypto.randomUUID(),
    nome: nome.trim(),
    email: email.trim(),
    telefone: telefone.trim(),
    discord: discord.trim(),
    motivo: motivo.trim(),
    mensagem: mensagem.trim(),
    criadoEm: new Date().toISOString(),
  };

  envios.push(novoEnvio);
  salvarEnvios(envios);

  enviarJson(res, 201, { ok: true, id: novoEnvio.id });
}

function tratarListarEnvios(req, res) {
  if (!autenticado(req)) {
    enviarJson(res, 401, { erro: 'Senha incorreta.' });
    return;
  }
  enviarJson(res, 200, lerEnvios());
}

function tratarExcluirEnvio(req, res, id) {
  if (!autenticado(req)) {
    enviarJson(res, 401, { erro: 'Senha incorreta.' });
    return;
  }

  const envios = lerEnvios();
  const restantes = envios.filter((envio) => envio.id !== id);

  if (restantes.length === envios.length) {
    enviarJson(res, 404, { erro: 'Envio não encontrado.' });
    return;
  }

  salvarEnvios(restantes);
  enviarJson(res, 200, { ok: true });
}

// ---------- servidor ----------

const servidor = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'POST' && url === '/api/enviar') {
    tratarEnviarFormulario(req, res);
    return;
  }

  if (req.method === 'GET' && url === '/api/envios') {
    tratarListarEnvios(req, res);
    return;
  }

  const combinaExclusao = url.match(/^\/api\/envios\/([a-zA-Z0-9-]+)$/);
  if (req.method === 'DELETE' && combinaExclusao) {
    tratarExcluirEnvio(req, res, combinaExclusao[1]);
    return;
  }

  if (req.method === 'GET') {
    servirArquivoEstatico(req, res);
    return;
  }

  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Método não permitido');
});

garantirArquivoDados();

servidor.listen(PORTA, () => {
  console.log(`Grupo Ticord rodando em http://localhost:${PORTA}`);
  console.log(`Painel admin: http://localhost:${PORTA}/admin.html (senha: ${ADMIN_SENHA})`);
});
