const prismaAdapter = require ('../adapters/prismaAdapter.js'); 

class UserService {

    static async listarContas () {
        const contas = await prismaAdapter.listarContas();

        if(!contas || contas.length === 0) throw new Error('Nenhuma conta encontrada');
        console.log('Contas encontradas:', contas);
        return contas;
    }

}

module.exports = UserService;