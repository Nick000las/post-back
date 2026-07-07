const constasConfig = require('../config/contas.json');

class JsonAdapter {

    static async listarContas () {
        return constasConfig.map(conta => ({
            id: conta.id,
            nome: conta.nome,
            plataforma: conta.plataforma
        }));
    }

}


module.exports = JsonAdapter;