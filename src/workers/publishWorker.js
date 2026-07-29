require('dotenv').config();
const { Worker, UnrecoverableError } = require('bullmq');
const connection = require('../config/redisConfig.js');
const { PUBLISH_QUEUE_NAME } = require('../queues/publishQueue.js');
const prismaAdapter = require('../adapters/prismaAdapter.js');
const metaAdapter = require('../adapters/metaAdapter.js');
const tiktokAdapter = require('../adapters/tiktokAdapter.js');
const linkedinAdapter = require('../adapters/linkedinAdapter.js');
const postService = require('../services/postService.js');
const cryptoUtil = require('../utils/cryptoUtil.js');
const AppError = require('../errors/AppError.js');

// valor inicial — ajustar conforme limites de rate-limit de cada plataforma / capacidade da máquina
const WORKER_CONCURRENCY = 5;

async function publicarNaConta (post, accessToken, conta) {
    switch (conta.platform) {
        case 'instagram':
            return metaAdapter.publicarNoInstagram(post, accessToken, conta.platform_account_id);
        case 'facebook':
            return metaAdapter.publicarNoFacebook(post, accessToken, conta.platform_account_id);
        case 'tiktok':
            return tiktokAdapter.publicarContainer(post, accessToken, conta.platform_account_id);
        case 'linkedin':
            return linkedinAdapter.publicarContainer(post, accessToken, conta.platform_account_id);
        default:
            throw new AppError(`Plataforma "${conta.platform}" não suportada`);
    }
}

async function registrarResultado (postId, accountId, status, apiPostId, errorMessage) {
    try {
        await prismaAdapter.vincularPostConta(postId, accountId, status, apiPostId, errorMessage);
    } catch (dbError) {
        console.error('Falha ao registrar resultado da conta no post', { postId, accountId, erro: dbError.message });
    }
}

async function processarJob (job) {
    const { postId, accountId, clientId } = job.data;

    const [post, conta] = await Promise.all([
        prismaAdapter.buscarPostPorId(postId),
        prismaAdapter.buscarContaPorId(accountId, clientId)
    ]);

    if (!post || !conta) throw new UnrecoverableError(`Post ${postId} ou conta ${accountId} não encontrado(a).`);

    // Primeiro job de um post agendado a rodar depois do delay do BullMQ: passa de SCHEDULED pra
    // PROCESSING. Seguro sob concorrência (vários jobs do mesmo post): é só uma sobrescrita de string,
    // e finalizarStatusSeCompleto sempre define o status final no fim.
    if (post.status === 'SCHEDULED') {
        await prismaAdapter.atualizarStatusPost(postId, 'PROCESSING');
    }

    try {
        const accessToken = cryptoUtil.decrypt(conta.access_token);
        const { externalId } = await publicarNaConta(post, accessToken, conta);

        await registrarResultado(postId, accountId, 'SUCCESS', externalId, null);
        await postService.finalizarStatusSeCompleto(postId);
    } catch (error) {
        if (error instanceof AppError) {
            console.warn(`Falha ao publicar post ${postId} na conta ${accountId}`, { postId, accountId, clientId, erro: error.message });
            await registrarResultado(postId, accountId, 'FAILED', null, error.message);
            await postService.finalizarStatusSeCompleto(postId);
            throw new UnrecoverableError(error.message);
        }

        // Erro transiente/inesperado: deixa o BullMQ tentar de novo. Só fecha o resultado quando
        // for a última tentativa, senão o post fecharia status errado com um retry ainda pendente.
        const estaNaUltimaTentativa = job.attemptsMade + 1 >= job.opts.attempts;
        if (estaNaUltimaTentativa) {
            console.error(`Erro inesperado ao publicar post ${postId} na conta ${accountId}`, { postId, accountId, clientId, erro: error.message, stack: error.stack });
            await registrarResultado(postId, accountId, 'FAILED', null, 'Erro ao publicar nesta conta. Tente novamente mais tarde.');
            await postService.finalizarStatusSeCompleto(postId);
        }

        throw error;
    }
}

const publishWorker = new Worker(PUBLISH_QUEUE_NAME, processarJob, {
    connection,
    concurrency: WORKER_CONCURRENCY
});

publishWorker.on('failed', (job, error) => {
    console.error(`Erro na operação do worker durante o post ${job.data.postId}: ${error.message}`);
});

module.exports = { publishWorker, processarJob };
