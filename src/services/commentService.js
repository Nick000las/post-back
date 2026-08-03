const prismaAdapter = require('../adapters/prismaAdapter.js');
const AppError = require('../errors/AppError.js');

class CommentService {

    static async #validarCliente (clientId, userId) {
        const cliente = await prismaAdapter.buscarClientePorId(clientId, userId);
        if (!cliente) throw new AppError('Cliente não encontrado');
        return cliente;
    }

    // Confirma que o post existe E pertence ao client informado (não filtra por status — comentário
    // deve funcionar em qualquer coluna/status do post, ao contrário de draft).
    static async #validarPost (postId, clientId) {
        const post = await prismaAdapter.buscarPostPorIdEClient(postId, clientId);
        if (!post) throw new AppError('Post não encontrado');
        return post;
    }

    static async listarComentarios (postId, clientId, userId) {
        await this.#validarCliente(clientId, userId);
        await this.#validarPost(postId, clientId);
        return prismaAdapter.listarComentarios(postId);
    }

    // arquivo vem de req.file (multer) ou é undefined/null se a mensagem não tem anexo.
    static async criarComentario (postId, clientId, userId, text, arquivo) {
        await this.#validarCliente(clientId, userId);
        await this.#validarPost(postId, clientId);
        if ((!text || !text.trim()) && !arquivo) throw new AppError('A mensagem precisa ter texto ou um anexo');
        const dadosAnexo = arquivo ? { 
            path: arquivo.filename, 
            originalName: arquivo.originalname, 
            mimeType: arquivo.mimetype, 
            size: arquivo.size 
        } : null;

        return prismaAdapter.criarComentario(postId, userId, text?.trim() || null, dadosAnexo);
    }
}

module.exports = CommentService;
