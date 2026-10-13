import type {
  AssignmentReason,
  ContentPackage,
  DiagnosticResult,
  Questionnaire,
} from '@luch/contracts';

// The initial demo bank uses the same topic suffixes for both languages.
const topicsByGoal: Record<Questionnaire['goal'], string[]> = {
  daily_life: ['introduction', 'family', 'plans', 'cafe', 'time', 'location'],
  travel: ['location', 'cafe', 'time', 'introduction'],
  work: ['introduction', 'time', 'plans'],
  study: ['time', 'introduction', 'plans'],
};
const goalNames: Record<Questionnaire['goal'], string> = {
  daily_life: 'повседневное общение',
  travel: 'путешествия',
  work: 'работа',
  study: 'учёба',
};
export function selectInitialLessons(
  bank: ContentPackage,
  routeId: string,
  questionnaire: Questionnaire,
  result: DiagnosticResult,
) {
  const route = bank.routes.find((route) => route.id === routeId);
  if (!route || route.language !== questionnaire.language) throw new Error('Plan route mismatch.');
  const goals = topicsByGoal[questionnaire.goal].map(
    (topic) => `${questionnaire.language === 'ru' ? 'ru' : 'en'}-${topic}`,
  );
  const ranked = route.lessonIds
    .flatMap((id, routePosition) => {
      const lesson = bank.lessons.find((item) => item.id === id)!;
      const exercises = bank.exercises.filter((e) => e.lessonId === id && e.purpose === 'practice');
      if (!exercises.length) return [];
      const skillIds = new Set(exercises.map((e) => e.skillId));
      const skills = result.skills.filter((s) => skillIds.has(s.skillId));
      const gaps = skills.filter((s) => s.correct < s.questions);
      const guided = skills.filter((s) => s.independentCorrect < s.correct);
      const goalIndex = goals.findIndex((id) => skillIds.has(id));
      const goalMatched = goalIndex >= 0;
      const kind: AssignmentReason['kind'] = gaps.length
        ? 'diagnostic_gap'
        : guided.length
          ? 'guided_success'
          : goalMatched
            ? 'goal_priority'
            : 'route_step';
      const evidence = gaps.length ? gaps : guided.length ? guided : skills;
      const detail = evidence
        .map((s) => `«${s.name}»: ${s.correct}/${s.questions} верно`)
        .join('; ');
      const text = gaps.length
        ? `В предварительной диагностике есть затруднение: ${detail}. Начните с практики этих навыков.`
        : guided.length
          ? `Навык требует самостоятельной практики: ${detail}. Успешные ответы были получены с помощью или после обратной связи.`
          : goalMatched
            ? `Урок связан с целью «${goalNames[questionnaire.goal]}». Это следующий шаг практики по выбранной цели.`
            : 'Следующий шаг выбранного маршрута. В короткой диагностике по этому уроку затруднение не выявлено либо навык не проверялся.';
      const reason: AssignmentReason = {
        kind,
        text,
        goal: questionnaire.goal,
        goalMatched,
        skills: evidence.map(({ skillId, name, correct, questions, independentCorrect }) => ({
          skillId,
          name,
          correct,
          questions,
          independentCorrect,
        })),
      };
      return [
        {
          lesson,
          exercises,
          reason,
          rank: gaps.length ? 0 : guided.length ? 1 : 2,
          goalRank: goalMatched ? goalIndex : goals.length,
          routePosition,
        },
      ];
    })
    .sort(
      (a, b) => a.rank - b.rank || a.goalRank - b.goalRank || a.routePosition - b.routePosition,
    );
  let day = 1,
    minutes = 0;
  return ranked.map((item, position) => {
    if (minutes > 0 && minutes + item.lesson.estimatedMinutes > questionnaire.minutesPerDay) {
      day++;
      minutes = 0;
    }
    minutes += item.lesson.estimatedMinutes;
    return { ...item, position, recommendedDay: day };
  });
}
