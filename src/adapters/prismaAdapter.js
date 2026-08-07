const { PrismaClient } = require('@prisma/client');
const cryptoUtil = require('../utils/cryptoUtil.js');
const { FIXED_COLUMN_KEYS, FIXED_COLUMNS_SEED, DIAS_VISIVEIS_COLUNA_FINALIZADO } = require('../constants/kanban.js');
const prisma = new PrismaClient();

const CONTA_SELECT_SEGURO = {
    id: true,
    name: true,
    platform: true,
    platform_account_id: true,
    created_at: true
};

// Campos do client expostos no card do Feed Global (autor do post) — mesmo padrão de
// CONTA_SELECT_SEGURO, evita vazar user_id ou outros campos internos do client.
const CLIENT_SELECT_FEED = {
    id: true,
    name: true,
    avatar_path: true
};

// Campos base de post reaproveitados em todo select de leitura (drafts, feed, quadro kanban etc.) —
// única fonte de verdade pra não esquecer um campo novo (ex.: thumbnail_path) em algum dos vários
// pontos que selecionam post.
const POST_SELECT_BASE = {
    id: true,
    caption: true,
    status: true,
    created_at: true,
    updated_at: true,
    published_at: true,
    suggested_date: true,
    format: true,
    post_media: { orderBy: { order: 'asc' } }
};

// createManyAndReturn (usado só por criarPostsEmLotePorIA) não aceita select de relação — só campos
// escalares. Derivado de POST_SELECT_BASE em vez de escrito à mão pra não sair de sincronia quando
// um campo escalar novo for adicionado lá.
const { post_media: _relacaoMidia, ...POST_SELECT_ESCALAR } = POST_SELECT_BASE;

// Conjunto de status que aparece nos dois feeds — exclui DRAFT (rascunho ainda não é "conteúdo
// entregue", nem pra troubleshooting nem pra portfólio).
const FEED_STATUS_NAO_DRAFT = ['SCHEDULED', 'PROCESSING', 'PUBLISHED', 'PARTIAL', 'FAILED'];

// Campos base de comentário reaproveitados em toda leitura de chat — já inclui o nome do autor
// (users.name) achatado via select, pra frontend não precisar de uma segunda chamada.
const COMMENT_SELECT_BASE = {
    id: true,
    post_id: true,
    text: true,
    attachment_path: true,
    attachment_original_name: true,
    attachment_mime_type: true,
    attachment_size: true,
    created_at: true,
    users: { select: { id: true, name: true } }
};


class PrismaAdapter {
    // Achata post_media -> media (já vem ordenado por `order` do POST_SELECT_BASE). Mesmo critério
    // de reshaping já usado pra post_accounts -> accounts: o nome da tabela é detalhe de
    // persistência, quem consome (frontend, worker, adapters de plataforma) só quer "a mídia".
    // Sempre um array — vazio quando o post não tem mídia (draft do Lab de IA, arte removida).
    static #comMidia(post) {
        const { post_media, ...resto } = post;
        return { ...resto, media: post_media ?? [] };
    }

    static async buscarClientePorId(clientId, userId) {
        return await prisma.clients.findFirst({
            where: { id: parseInt(clientId), user_id: userId }
        });
    }

    static async criarClient(name, userId) {
        return await prisma.$transaction(async (tx) => {
            const client = await tx.clients.create({
                data: { name, user_id: userId }
            });

            await tx.columns.createMany({
                data: FIXED_COLUMNS_SEED.map(coluna => ({
                    ...coluna,
                    is_fixed: true,
                    client_id: client.id
                }))
            });

            return client;
        });
    }

    static async listarClients(userId) {
        return await prisma.clients.findMany({
            where: { user_id: userId },
            orderBy: { created_at: 'desc' }
        });
    }

    static async atualizarClient(id, userId, name) {
        const resultado = await prisma.clients.updateMany({
            where: { id: parseInt(id), user_id: userId },
            data: { name }
        });
        if (resultado.count === 0) return null;

        return await prisma.clients.findUnique({ where: { id: parseInt(id) } });
    }

    static async excluirClient(id, userId) {
        const client = await prisma.clients.findFirst({
            where: { id: parseInt(id), user_id: userId }
        });
        if (!client) return null;

        await prisma.clients.delete({ where: { id: client.id } });
        return client;
    }

    // ---- Kanban: colunas ----

    static async listarColunas(clientId) {
        return await prisma.columns.findMany({
            where: { client_id: parseInt(clientId) },
            orderBy: { order: 'asc' }
        });
    }

    static async buscarColunaPorId(id, clientId) {
        return await prisma.columns.findFirst({
            where: { id: parseInt(id), client_id: parseInt(clientId) }
        });
    }

    // Ponto de resolução reutilizável do "gancho de IA": toda criação de post que não vier com
    // column_id explícito cai aqui (via kanbanService.resolverColunaIdeias).
    static async buscarColunaIdeias(clientId) {
        return await prisma.columns.findFirst({
            where: { client_id: parseInt(clientId), fixed_key: FIXED_COLUMN_KEYS.IDEIAS },
            select: { id: true }
        });
    }

    // Genérico: busca qualquer uma das 3 colunas fixas (Rascunhos/Agendado/Finalizado) do client. Usado
    // pelo salto automático de coluna quando um post muda de status (ver postService#moverParaColunaFixa).
    static async buscarColunaPorFixedKey(clientId, fixedKey) {
        return await prisma.columns.findFirst({
            where: { client_id: parseInt(clientId), fixed_key: fixedKey },
            select: { id: true }
        });
    }

    static async criarColunaDinamica(clientId, name) {
        const [maiorOrderDinamica, colunaIdeias] = await Promise.all([
            prisma.columns.aggregate({
                where: { client_id: parseInt(clientId), is_fixed: false },
                _max: { order: true }
            }),
            prisma.columns.findFirst({
                where: { client_id: parseInt(clientId), fixed_key: FIXED_COLUMN_KEYS.IDEIAS },
                select: { order: true }
            })
        ]);

        const order = (maiorOrderDinamica._max.order ?? colunaIdeias.order) + 1;

        return await prisma.columns.create({
            data: { name, client_id: parseInt(clientId), order, is_fixed: false }
        });
    }

    static async renomearColuna(id, clientId, name) {
        const resultado = await prisma.columns.updateMany({
            where: { id: parseInt(id), client_id: parseInt(clientId), is_fixed: false },
            data: { name }
        });
        if (resultado.count === 0) return null;

        return await prisma.columns.findUnique({ where: { id: parseInt(id) } });
    }

    static async excluirColunaDinamica(id, clientId) {
        return await prisma.$transaction(async (tx) => {
            const coluna = await tx.columns.findFirst({
                where: { id: parseInt(id), client_id: parseInt(clientId), is_fixed: false },
                select: { id: true, name: true }
            });
            if (!coluna) return null;

            const colunaIdeias = await tx.columns.findFirst({
                where: { client_id: parseInt(clientId), fixed_key: FIXED_COLUMN_KEYS.IDEIAS },
                select: { id: true }
            });
            if (!colunaIdeias) throw new Error(`Client ${clientId} sem coluna Rascunhos — inconsistência de dados`);

            const { count: postsMovidos } = await tx.posts.updateMany({
                where: { client_id: parseInt(clientId), column_id: parseInt(id) },
                data: { column_id: colunaIdeias.id }
            });

            await tx.columns.delete({ where: { id: coluna.id } });
            return { ...coluna, postsMovidos };
        });
    }


    static async moverPostDeColuna(postId, clientId, columnId) {
        const resultado = await prisma.posts.updateMany({
            where: { id: parseInt(postId), client_id: parseInt(clientId) },
            data: { column_id: parseInt(columnId), updated_at: new Date() }
        });
        if (resultado.count === 0) return null;

        return await prisma.posts.findUnique({ where: { id: parseInt(postId) } });
    }

    static async buscarQuadro(clientId) {
        const columns = await prisma.columns.findMany({
            where: { client_id: parseInt(clientId) },
            orderBy: { order: 'asc' },
            select: {
                id: true, name: true, order: true, is_fixed: true, fixed_key: true,
                posts: {
                    select: {
                        ...POST_SELECT_BASE,
                        scheduled_for: true,
                        post_accounts: { select: { accounts: { select: CONTA_SELECT_SEGURO } } }
                    }
                }
            }
        });

        // Corte de retenção só da coluna Finalizado (ver DIAS_VISIVEIS_COLUNA_FINALIZADO) — usa
        // updated_at como proxy de "quando finalizou": nada mais toca esse campo depois que o post
        // entra em Finalizado (edição de legenda só existe pra DRAFT, e mover manualmente pra dentro
        // dessa coluna já é bloqueado em kanbanService.moverPost).
        const dataLimiteFinalizado = new Date();
        dataLimiteFinalizado.setDate(dataLimiteFinalizado.getDate() - DIAS_VISIVEIS_COLUNA_FINALIZADO);

        return columns.map(({ posts, ...column }) => {
            const postsVisiveis = column.fixed_key === FIXED_COLUMN_KEYS.FINALIZADO
                ? posts.filter(post => post.updated_at >= dataLimiteFinalizado)
                : posts;

            return {
                ...column,
                posts: postsVisiveis.map(({ post_accounts, ...post }) => ({
                    ...PrismaAdapter.#comMidia(post),
                    accounts: post_accounts.map(vinculo => vinculo.accounts)
                }))
            };
        });
    }

    static async buscarUsuarioPorEmail(email) {
        return await prisma.users.findUnique({
            where: { email }
        });
    }

    static async buscarUsuarioPorId(id) {
        return await prisma.users.findUnique({
            where: { id }
        });
    }

    static async criarUsuario(name, email, passwordHash) {
        return await prisma.users.create({
            data: { name, email, password_hash: passwordHash }
        });
    }


    // midiaItems: [{ filePath, fileName, fileType, thumbnailPath }] na ordem de exibição do
    // carrossel — o índice do array vira o `order`. Array vazio é válido (post sem mídia).
    static async criarPost(caption, midiaItems, status, clientId, scheduledFor = null, columnId = null) {
        const post = await prisma.posts.create({
            data: {
                caption,
                status,
                client_id: parseInt(clientId),
                scheduled_for: scheduledFor,
                column_id: columnId,
                post_media: { create: PrismaAdapter.#montarMidiaParaCriacao(midiaItems) }
            },
            select: POST_SELECT_BASE
        });
        return PrismaAdapter.#comMidia(post);
    }

    // Traduz o shape camelCase que os services usam pro snake_case da tabela, atribuindo o `order`
    // pela posição no array. Único lugar que faz esse mapeamento — criarPost, criarDraftComContas e
    // substituirMidiaDoPost compartilham.
    static #montarMidiaParaCriacao(midiaItems = []) {
        return midiaItems.map((item, index) => ({
            file_path: item.filePath,
            file_name: item.fileName,
            file_type: item.fileType,
            thumbnail_path: item.thumbnailPath ?? null,
            order: index
        }));
    }

    static async registrarJobAgendado(postId, accountId, jobId) {
        return await prisma.post_accounts.upsert({
            where: { post_id_account_id: { post_id: postId, account_id: accountId } },
            create: { post_id: postId, account_id: accountId, delivery_status: 'PENDING', job_id: jobId },
            update: { job_id: jobId }
        });
    }

    // extra: campos adicionais pra mesclar no update (usado por postService#finalizarStatusSeCompleto
    // pra gravar published_at junto com o status final, numa única query).
    static async atualizarStatusPost(postId, status, extra = {}) {
        return await prisma.posts.update({
            where: { id: parseInt(postId) },
            data: { status, updated_at: new Date(), ...extra }
        });
    }

    static async atualizarScheduledFor(postId, scheduledFor) {
        return await prisma.posts.update({
            where: { id: parseInt(postId) },
            data: { scheduled_for: scheduledFor, updated_at: new Date() }
        });
    }

    static async vincularPostConta(postId, accountId, status, apiPostId, errorMessage) {
        const dados = {
            delivery_status: status,
            api_post_id: apiPostId,
            error_message: errorMessage,
            processed_at: new Date()
        };

        return await prisma.post_accounts.upsert({
            where: { post_id_account_id: { post_id: parseInt(postId), account_id: parseInt(accountId) } },
            create: { post_id: parseInt(postId), account_id: parseInt(accountId), ...dados },
            update: dados
        });
    }

    static async listarContas(clientId) {
        return await prisma.accounts.findMany({
            where: { client_id: parseInt(clientId) },
            select: CONTA_SELECT_SEGURO
        });
    }

    static async buscarContaPorId(id, clientId) {
        return await prisma.accounts.findFirst({
            where: { id: parseInt(id), client_id: parseInt(clientId) }
        });
    }

    static async buscarContaPorPlatformAccountId(platformAccountId) {
        return await prisma.accounts.findUnique({
            where: { platform_account_id: platformAccountId }
        });
    }

    static async criarConta(contaData) {
        const dadosCriptografados = { ...contaData, access_token: cryptoUtil.encrypt(contaData.access_token) };
        return await prisma.accounts.create({
            data: dadosCriptografados,
            select: CONTA_SELECT_SEGURO
        });
    }

    static async atualizarConta(id, clientId, atualizacoes) {
        const dados = atualizacoes.access_token
            ? { ...atualizacoes, access_token: cryptoUtil.encrypt(atualizacoes.access_token) }
            : atualizacoes;

        const resultado = await prisma.accounts.updateMany({
            where: { id: parseInt(id), client_id: parseInt(clientId) },
            data: dados
        });
        if (resultado.count === 0) return null;

        return await prisma.accounts.findUnique({
            where: { id: parseInt(id) },
            select: CONTA_SELECT_SEGURO
        });
    }

    static async excluirConta(id, clientId) {
        const conta = await prisma.accounts.findFirst({
            where: { id: parseInt(id), client_id: parseInt(clientId) },
            select: CONTA_SELECT_SEGURO
        });
        if (!conta) return null;

        await prisma.accounts.delete({ where: { id: parseInt(id) } });
        return conta;
    }

    static async criarDraftComContas(caption, midiaItems, clientId, accountIds, columnId = null) {
        return await prisma.$transaction(async (tx) => {
            const draft = await tx.posts.create({
                data: {
                    caption,
                    status: 'DRAFT',
                    client_id: parseInt(clientId),
                    column_id: columnId,
                    post_media: { create: PrismaAdapter.#montarMidiaParaCriacao(midiaItems) }
                },
                select: POST_SELECT_BASE
            });

            await tx.post_accounts.createMany({
                data: accountIds.map(accountId => ({
                    post_id: draft.id,
                    account_id: accountId,
                    delivery_status: 'PENDING'
                }))
            });

            return PrismaAdapter.#comMidia(draft);
        });
    }

    static async buscarDraftPorId(draftId, clientId) {
        const draft = await prisma.posts.findFirst({
            where: { id: parseInt(draftId), client_id: parseInt(clientId), status: 'DRAFT' },
            select: POST_SELECT_BASE
        });
        return draft && PrismaAdapter.#comMidia(draft);
    }

    // Consumido pelo worker (publishWorker) e repassado direto pros adapters de plataforma, que
    // leem post.media — por isso precisa do select explícito com a relação (findUnique sem select
    // traria só os campos escalares, e a mídia chegaria undefined lá na hora de publicar).
    static async buscarPostPorId(postId) {
        const post = await prisma.posts.findUnique({
            where: { id: postId },
            select: { ...POST_SELECT_BASE, client_id: true, scheduled_for: true, column_id: true }
        });
        return post && PrismaAdapter.#comMidia(post);
    }

   
    static async buscarPostPorIdEClient(postId, clientId) {
        return await prisma.posts.findFirst({ 
            where: { id: parseInt(postId), client_id: parseInt(clientId) },
            select: { id: true }
        });
    }

    static async listarComentarios(postId) {
        return await prisma.card_comments.findMany({
            where: { post_id: parseInt(postId) },
            orderBy: { created_at: 'asc' },
            select: COMMENT_SELECT_BASE
        });
    }


    static async criarComentario(postId, userId, text, dadosAnexo) {
        return await prisma.card_comments.create({
            data: {
                post_id: parseInt(postId),
                user_id: userId,
                text,
                attachment_path: dadosAnexo?.path ?? null,
                attachment_original_name: dadosAnexo?.originalName ?? null,
                attachment_mime_type: dadosAnexo?.mimeType ?? null,
                attachment_size: dadosAnexo?.size ?? null
            },
            select: COMMENT_SELECT_BASE
        });
    }

    static async buscarPostComStatusContas(postId, clientId) {
        const post = await prisma.posts.findFirst({
            where: { id: parseInt(postId), client_id: parseInt(clientId) },
            select: {
                id: true,
                status: true,
                post_accounts: {
                    select: {
                        delivery_status: true,
                        error_message: true,
                        accounts: { select: { id: true, platform: true } }
                    }
                }
            }
        });
        if (!post) return null;

        const { post_accounts, ...rest } = post;
        return {
            ...rest,
            accounts: post_accounts.map(vinculo => ({
                accountId: vinculo.accounts.id,
                platform: vinculo.accounts.platform,
                delivery_status: vinculo.delivery_status,
                error_message: vinculo.error_message
            }))
        };
    }

    // Só serve pra localizar os job_id na fila (cancelar/reagendar/excluir) — não precisa de mídia.
    static async buscarPostAgendadoComJobs(postId, clientId) {
        return await prisma.posts.findFirst({
            where: { id: parseInt(postId), client_id: parseInt(clientId), status: 'SCHEDULED' },
            select: {
                id: true,
                post_accounts: { select: { job_id: true } }
            }
        });
    }

    // Cancelar agendamento não apaga mais o post — reverte pra DRAFT (arte/legenda preservadas), pra
    // a agência poder reagendar depois sem refazer o upload. Retorna null se não achar um SCHEDULED
    // com esse id+client (mesma regra de posse de sempre).
    static async reverterAgendamentoParaDraft(postId, clientId) {
        const resultado = await prisma.posts.updateMany({
            where: { id: parseInt(postId), client_id: parseInt(clientId), status: 'SCHEDULED' },
            data: { status: 'DRAFT', scheduled_for: null, updated_at: new Date() }
        });
        if (resultado.count === 0) return null;
        const post = await prisma.posts.findUnique({ where: { id: parseInt(postId) }, select: POST_SELECT_BASE });
        return PrismaAdapter.#comMidia(post);
    }

    // Exclusão definitiva de post em QUALQUER status (ao contrário de excluirDraft, que só aceita
    // DRAFT) — usada pelo botão de lixeira do popup do Kanban. card_comments e post_media têm
    // onDelete: Cascade no schema, então somem junto automaticamente — mas a mídia precisa vir no
    // retorno pro service conseguir apagar os arquivos do disco antes de perder a referência.
    static async excluirPostDefinitivo(postId, clientId) {
        const post = await prisma.posts.findFirst({
            where: { id: parseInt(postId), client_id: parseInt(clientId) },
            select: { id: true, post_media: { orderBy: { order: 'asc' } } }
        });
        if (!post) return null;

        await prisma.posts.delete({ where: { id: post.id } });
        return PrismaAdapter.#comMidia(post);
    }

    static async listarStatusContasDoPost(postId) {
        return await prisma.post_accounts.findMany({
            where: { post_id: postId },
            select: { delivery_status: true }
        });
    }

    static async buscarDraftComContas(draftId, clientId) {
        const draft = await prisma.posts.findFirst({
            where: { id: parseInt(draftId), client_id: parseInt(clientId), status: 'DRAFT' },
            select: {
                ...POST_SELECT_BASE,
                post_accounts: { select: { accounts: { select: CONTA_SELECT_SEGURO } } }
            }
        });
        if (!draft) return null;

        const { post_accounts, ...draftSemVinculos } = draft;
        return {
            ...PrismaAdapter.#comMidia(draftSemVinculos),
            accounts: post_accounts.map(vinculo => vinculo.accounts)
        };
    }

    static async listarContasDoDraft(draftId, clientId) {
        const vinculos = await prisma.post_accounts.findMany({
            where: { post_id: parseInt(draftId), accounts: { client_id: parseInt(clientId) } },
            select: { account_id: true }
        });
        return vinculos.map(vinculo => ({ id: vinculo.account_id }));
    }

    static async substituirContasDoDraft(draftId, clientId, accountIds) {
        return await prisma.$transaction(async (tx) => {
            await tx.post_accounts.deleteMany({
                where: { post_id: parseInt(draftId), posts: { client_id: parseInt(clientId) } }
            });

            if (accountIds.length > 0) {
                await tx.post_accounts.createMany({
                    data: accountIds.map(accountId => ({
                        post_id: parseInt(draftId),
                        account_id: accountId,
                        delivery_status: 'PENDING'
                    }))
                });
            }

            const vinculos = await tx.post_accounts.findMany({
                where: { post_id: parseInt(draftId) },
                select: { accounts: { select: CONTA_SELECT_SEGURO } }
            });
            return vinculos.map(vinculo => vinculo.accounts);
        });
    }

    static async excluirDraft(draftId, clientId) {
        const draft = await prisma.posts.findFirst({
            where: { id: parseInt(draftId), client_id: parseInt(clientId), status: 'DRAFT' },
            select: POST_SELECT_BASE
        });
        if (!draft) return null;

        await prisma.posts.delete({ where: { id: draft.id } });
        return PrismaAdapter.#comMidia(draft);
    }

    static async atualizarDraft(draftId, caption, clientId) {
        const resultado = await prisma.posts.updateMany({
            where: { id: parseInt(draftId), client_id: parseInt(clientId), status: 'DRAFT' },
            data: { caption, updated_at: new Date() }
        });
        if (resultado.count === 0) return null;

        const draft = await prisma.posts.findUnique({
            where: { id: parseInt(draftId) },
            select: POST_SELECT_BASE
        });
        return PrismaAdapter.#comMidia(draft);
    }

    // Substitui TODA a mídia de um draft pelo conjunto novo (edição no popup do Kanban) — nunca um
    // PATCH de um item isolado, por isso delete-all + insert, mesmo padrão de
    // substituirContasDoDraft. Transação porque é destrutivo: sem ela, uma falha no create deixaria
    // o draft sem nenhuma mídia (pior que o estado original). midiaItems vazio é válido (equivale a
    // remover toda a mídia). Retorna null se não for um DRAFT desse client.
    static async substituirMidiaDoPost(draftId, clientId, midiaItems) {
        return await prisma.$transaction(async (tx) => {
            const { count } = await tx.posts.updateMany({
                where: { id: parseInt(draftId), client_id: parseInt(clientId), status: 'DRAFT' },
                data: { updated_at: new Date() }
            });
            if (count === 0) return null;

            await tx.post_media.deleteMany({ where: { post_id: parseInt(draftId) } });

            const novaMidia = PrismaAdapter.#montarMidiaParaCriacao(midiaItems);
            if (novaMidia.length > 0) {
                await tx.post_media.createMany({
                    data: novaMidia.map(item => ({ ...item, post_id: parseInt(draftId) }))
                });
            }

            const draft = await tx.posts.findUnique({
                where: { id: parseInt(draftId) },
                select: POST_SELECT_BASE
            });
            return PrismaAdapter.#comMidia(draft);
        });
    }

    // Remove só UM item do carrossel, sem tocar nos demais — complementa substituirMidiaDoPost
    // (que troca o conjunto inteiro). Retorna o item apagado (pro service limpar o disco) ou null
    // se não achou (mediaId não existe, não pertence a esse draft, ou draft não é DRAFT/não é desse
    // client). Não renumera o `order` dos itens restantes: um buraco na sequência (ex.: 0, 2) não
    // afeta o ORDER BY que já é usado em todo select — só a contiguidade, que ninguém depende dela.
    static async removerItemDeMidia(mediaId, draftId, clientId) {
        const item = await prisma.post_media.findFirst({
            where: {
                id: parseInt(mediaId),
                post_id: parseInt(draftId),
                posts: { client_id: parseInt(clientId), status: 'DRAFT' }
            }
        });
        if (!item) return null;

        await prisma.post_media.delete({ where: { id: item.id } });
        return item;
    }

    static async listarDrafts(clientId) {
        const drafts = await prisma.posts.findMany({
            where: { client_id: parseInt(clientId), status: 'DRAFT' },
            orderBy: { updated_at: 'desc' },
            select: {
                ...POST_SELECT_BASE,
                post_accounts: { select: { accounts: { select: CONTA_SELECT_SEGURO } } }
            }
        });

        return drafts.map(({ post_accounts, ...draft }) => ({
            ...PrismaAdapter.#comMidia(draft),
            accounts: post_accounts.map(vinculo => vinculo.accounts)
        }));
    }

    // Achata post_accounts -> accounts (com delivery_status/error_message embutidos), post_media ->
    // media e, quando incluirAutor, renomeia clients -> author. Fonte única de shaping reaproveitada
    // pelos dois feeds, pra não duplicar esse .map() em cada método de listagem.
    static #formatarPostDoFeed(post, { incluirAutor }) {
        const { post_accounts, clients, ...resto } = post;

        const postFormatado = {
            ...PrismaAdapter.#comMidia(resto),
            accounts: post_accounts.map(vinculo => ({
                ...vinculo.accounts,
                delivery_status: vinculo.delivery_status,
                error_message: vinculo.error_message
            }))
        };

        return incluirAutor ? { ...postFormatado, author: clients } : postFormatado;
    }

    // Feed Global ("torre de controle"): cross-client, mas sempre escopado ao usuário autenticado
    // (clients.user_id) — sem esse filtro, uma agência enxergaria posts de outra. clientId isola
    // um único client (dropdown de filtro); intervalo filtra por updated_at (mesmo campo já usado
    // na ordenação — "última atividade relevante", o que a torre de controle quer ver "hoje").
    static async listarFeedGlobal({ userId, clientId, statusList, intervalo, page, limit }) {
        const where = {
            status: { in: statusList },
            clients: { user_id: userId },
            ...(clientId && { client_id: parseInt(clientId) }),
            ...(intervalo && { updated_at: { gte: intervalo.from, lte: intervalo.to } })
        };
        const skip = (page - 1) * limit;

        const [posts, total] = await Promise.all([
            prisma.posts.findMany({
                where,
                orderBy: { updated_at: 'desc' },
                skip,
                take: limit,
                select: {
                    ...POST_SELECT_BASE,
                    clients: { select: CLIENT_SELECT_FEED },
                    post_accounts: {
                        select: {
                            delivery_status: true,
                            error_message: true,
                            accounts: { select: CONTA_SELECT_SEGURO }
                        }
                    }
                }
            }),
            prisma.posts.count({ where })
        ]);

        return {
            posts: posts.map(post => PrismaAdapter.#formatarPostDoFeed(post, { incluirAutor: true })),
            total
        };
    }

    // Feed do Cliente ("vitrine/portfólio"): sempre de um único client (posse já validada pelo
    // service via #validarCliente) — por design não busca nem expõe clients (author), já que o
    // frontend já está no contexto do client. platform filtra por posts que tenham ao menos uma
    // conta daquela rede; intervalo (mês/ano) filtra por published_at, com fallback pra updated_at
    // nos posts anteriores à existência desse campo (published_at nulo).
    static async listarFeedCliente({ clientId, platform, intervalo, page, limit }) {
        const where = {
            client_id: parseInt(clientId),
            status: { in: FEED_STATUS_NAO_DRAFT },
            ...(platform && { post_accounts: { some: { accounts: { platform } } } }),
            ...(intervalo && {
                OR: [
                    { published_at: { gte: intervalo.from, lte: intervalo.to } },
                    { published_at: null, updated_at: { gte: intervalo.from, lte: intervalo.to } }
                ]
            })
        };
        const skip = (page - 1) * limit;

        const [posts, total] = await Promise.all([
            prisma.posts.findMany({
                where,
                orderBy: { updated_at: 'desc' },
                skip,
                take: limit,
                select: {
                    ...POST_SELECT_BASE,
                    post_accounts: {
                        select: {
                            delivery_status: true,
                            error_message: true,
                            accounts: { select: CONTA_SELECT_SEGURO }
                        }
                    }
                }
            }),
            prisma.posts.count({ where })
        ]);

        return {
            posts: posts.map(post => PrismaAdapter.#formatarPostDoFeed(post, { incluirAutor: false })),
            total
        };
    }

    static async criarPostsEmLotePorIA (clientId, columnId, posts) {
        const criados = await prisma.posts.createManyAndReturn({
            data: posts.map(post => ({
                caption: post.caption ?? null,
                format: post.format ?? null,
                suggested_date: post.suggestedDate ? new Date(post.suggestedDate) : null,
                status: 'DRAFT',
                client_id: parseInt(clientId),
                column_id: columnId
            })),
            select: POST_SELECT_ESCALAR
        });

        // media sempre [] — post importado do PDF nasce sem arquivo. Devolvido explicitamente pro
        // shape bater com o de qualquer outra leitura de post (frontend não precisa de caso especial).
        return criados.map(post => ({ ...post, media: [] }));
    }
}

module.exports = PrismaAdapter;
