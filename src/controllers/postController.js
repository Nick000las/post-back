const postService = require('../services/postService.js');
const fs =  require('fs');

class PostController {

    static async publicarImagemInstagram (req, res) {
        const { caption } = req.body;
        const arquivo = req.file;

        if (!arquivo) {
            return res.status(400).json({ error: 'Imagem inválida' });
        }
        if (!caption || !caption.trim()) {
            fs.unlinkSync(arquivo.path);
            return res.status(400).json({ error: 'Falta de legenda para a postagem' });
        }
        try {
            const postId = await postService.executarPostagemImagemInstagram(arquivo, caption);

            return res.status(200).json({ message: 'Postagem realizada com sucesso', postId });

        }catch (error) {

            if (arquivo && fs.existsSync(arquivo.path)) {
                fs.unlinkSync(arquivo.path);
            }

            console.error('Erro ao publicar imagem no Instagram:', error);
            res.status(500).json({ error: 'Erro ao publicar imagem no Instagram' });
        }
    }

    static async publicarVideoInstagram (req, res) {
        const { caption } = req.body;
        const arquivo = req.file;

        if (!arquivo) {
            return res.status(400).json({ error: 'Vídeo inválido' });
        }
        if (!caption || !caption.trim()) {
            fs.unlinkSync(arquivo.path);
            return res.status(400).json({ error: 'Falta de legenda para a postagem' });
        }
        try {
            const postId = await postService.executarPostagemVideoInstagram(arquivo, caption);

            return res.status(200).json({ message: 'Postagem realizada com sucesso', postId });

        }catch (error) {

            if (arquivo && fs.existsSync(arquivo.path)) {
                fs.unlinkSync(arquivo.path);
            }

            console.error('Erro ao publicar vídeo no Instagram:', error);
            res.status(500).json({ error: 'Erro ao publicar vídeo no Instagram' });
        }
    }
}

module.exports = PostController;