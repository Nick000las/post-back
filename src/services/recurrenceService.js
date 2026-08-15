const AppError = require('../errors/AppError.js');
const schedulingHelpers = require('./schedulingHelpers.js');

// Validação da lista de datas de uma série de Stories. As datas já vêm PRONTAS do frontend — mesmo
// formato ISO 8601 com fuso explícito que scheduled_for já usa nas outras rotas de agendamento, só
// que aqui pode vir mais de uma. Não há cálculo de "toda sábado até tal data" no backend: quem
// decide os dias da série é quem manda a lista. Este módulo só valida.
class RecurrenceService {

    static validarRegra (datas) {
        if (!Array.isArray(datas) || datas.length === 0) throw new AppError('Informe ao menos uma data de agendamento');

        // toISOString normaliza pra UTC antes de comparar — duas strings com offsets diferentes mas
        // o mesmo instante (ex.: 21:00Z e 18:00-03:00) contam como duplicata.
        const instantes = datas.map(data => {
            schedulingHelpers.validarFormatoData(data);
            const instante = new Date(data);
            if (instante.getTime() <= Date.now()) {
                throw new AppError(`Data de agendamento inválida: ${data} (deve estar no futuro)`);
            }
            return instante.toISOString();
        });

        if (new Set(instantes).size !== instantes.length) {
            throw new AppError('Datas de agendamento repetidas');
        }
    }
}

module.exports = RecurrenceService;
