import type { AssistantContext, AssistantPreferences, AssistantAction } from '@luch/contracts';

export class DemoAssistantAdapter {
  async reply(input: {
    context: AssistantContext;
    preferences: AssistantPreferences;
    action: AssistantAction;
    text: string;
    hint: string | null;
    dialogueTurn: number;
  }) {
    const { context: c, preferences: p, action, hint, dialogueTurn } = input;
    const formal = p.address === 'formal';
    if (c.purpose !== 'practice')
      return `Это ${c.purpose === 'control' ? 'контрольное задание' : 'диагностика'}. ${c.exercise.instruction.slice(0, 1200)}\n${formal ? 'Выберите' : 'Выбери'} вариант или введите короткий ответ и отправьте его на проверку. Учебные подсказки и диалог здесь отключены; результат откроется после завершения набора.`;
    if (action === 'hint')
      return hint
        ? `Подсказка к текущему заданию: ${hint}\n${formal ? 'Попробуйте' : 'Попробуй'} теперь ответить самостоятельно.`
        : 'Дополнительных подсказок в этом задании нет. Посмотрите учебный материал и попробуйте ответить.';
    const lead =
      p.avatarId === 'partner'
        ? 'Перейдём к задаче.'
        : p.avatarId === 'guide'
          ? 'Небольшая учебная миссия.'
          : 'Разберём по шагам.';
    if (action === 'explain') {
      const response =
        c.exercise.response.type === 'choice'
          ? 'Нужно выбрать один вариант.'
          : 'Нужно ввести короткую фразу.';
      const last = c.lastAttempt?.exerciseId === c.exercise.id ? c.lastAttempt.evaluation : null;
      const feedback = last
        ? `\nПоследняя попытка: ${last.correct ? 'ответ верный' : 'в ответе есть ошибка'}. ${last.explanation.slice(0, 1200)}`
        : '';
      const material =
        p.detail === 'detailed'
          ? c.material
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n')
              .slice(0, 1600)
          : '';
      return `${lead}\n${c.exercise.instruction.slice(0, 1200)}\n${response} ${formal ? 'Сначала прочитайте' : 'Сначала прочитай'} материал, затем ${formal ? 'сопоставьте' : 'сопоставь'} ответ с ситуацией.${material ? '\nОпора из урока: ' + material : ''}${feedback}\nГотовый ответ до попытки не подставляю.`;
    }
    const lines = c.material.flatMap((b) => (b.type === 'dialogue' ? b.lines : []));
    const words = c.material.flatMap((b) => (b.type === 'vocabulary' ? b.items : []));
    const turn = dialogueTurn % 3;
    const line =
      lines.find((l, i) => i >= turn && /[?？]/.test(l.text)) ??
      lines[turn % Math.max(1, lines.length)];
    const question =
      line?.text ??
      (c.exercise.language === 'en'
        ? [
            'What would you say in this situation?',
            'Can you give a short example?',
            'What would you ask next?',
          ][turn]
        : [
            'Что вы скажете в этой ситуации?',
            'Приведите короткий пример.',
            'О чём вы спросите собеседника?',
          ][turn]);
    const topic = words
      .slice(0, 3)
      .map((w) => w.term)
      .join(', ');
    return `${lead} Тема — ${c.topic}${c.goal ? ' · цель: ' + ({ work: 'работа', travel: 'путешествия', daily_life: 'повседневное общение', study: 'учёба' }[c.goal] ?? c.goal) : ''}.\n${question}${p.detail === 'detailed' && topic ? '\nМожно использовать слова урока: ' + topic : ''}\n${turn === 2 ? 'После этой реплики вернёмся к самостоятельному упражнению.' : formal ? 'Ответьте одной-двумя фразами.' : 'Ответь одной-двумя фразами.'}`;
  }
}
