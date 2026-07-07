const jsonAdapter = require('../adapters/jsonAdapter.js');

class UserService {

    static async listarContas () {
        const contas = await jsonAdapter.listarContas();

        if(!contas || contas.length === 0) throw new Error('Nenhuma conta encontrada');
        console.log('Contas encontradas:', contas);
        return contas;
    }

}

module.exports = UserService;