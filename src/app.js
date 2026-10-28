/* Yahtzee — game flow and interface. */
(function () {
  'use strict';

  const E = window.YahtzeeEngine;
  if (!E) {
    console.error('YahtzeeEngine failed to load.');
    return;
  }

  const optimalTable = (typeof E.decodeOptimalTable === 'function' &&
    typeof globalThis.YAHTZEE_OPTIMAL_B64 === 'string')
    ? E.decodeOptimalTable(globalThis.YAHTZEE_OPTIMAL_B64)
    : null;
  if (globalThis.YAHTZEE_OPTIMAL_B64 && !optimalTable) {
    console.warn('Optimal table failed to decode; using the heuristic fallback.');
  }
  const engine = E.createEngine({ optimalTable: optimalTable });
  const MATCH_W_START_ROUND = 12;
  let matchSolver = null;
  if (window.YahtzeeMatch && engine.hasOptimalTable) {
    try {
      matchSolver = window.YahtzeeMatch.createLateGameSolver(engine);
    } catch (err) {
      console.warn('Match-W endgame unavailable; using Exact-W.', err);
    }
  }
  const CATS = E.CATEGORIES;
  const PLAYER = 0;
  const CPU = 1;
  const DIE_PIPS = {
    1: [4],
    2: [0, 8],
    3: [0, 4, 8],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8]
  };
  const HOLD_DELAY = 420;
  const ROLL_SETTLE = 260;

  const $ = function (selector) { return document.querySelector(selector); };
  const room = {
    diceTray: $('#diceTray'),
    rollBtn: $('#rollBtn'),
    prompt: $('#prompt'),
    turnName: $('#turnName'),
    rollsBadge: $('#rollsBadge'),
    statusDot: $('#statusDot'),
    recordValue: $('#recordValue'),
    record: $('#record'),
    coachBtn: $('#coachBtn'),
    rulesBtn: $('#rulesBtn'),
    newBtn: $('#newBtn'),
    insightTag: $('#insightTag'),
    insightNote: $('#insightNote'),
    insightBody: $('#insightBody'),
    scorecard: $('#scorecard'),
    scoreBody: $('#scoreBody'),
    overModal: $('#overModal'),
    overTitle: $('#overTitle'),
    overEyebrow: $('#overEyebrow'),
    finalScores: $('#finalScores'),
    finalDetail: $('#finalDetail'),
    playAgain: $('#playAgain'),
    live: $('#live'),
    loading: $('#loading'),
    recordNote: $('#recordNote')
  };

  const state = {
    gameId: 0,
    cards: [E.blankCard(), E.blankCard()],
    turn: PLAYER,
    phase: 'roll', // roll | score | ai | over
    rollsLeft: 3,
    dice: [0, 0, 0, 0, 0],
    held: [false, false, false, false, false],
    hasRolled: false,
    busy: false,
    coach: loadBool('yahtzee.coach.v1', true),
    coachSolver: null,
    coachSignature: '',
    aiLog: [],
    aiFinal: null,
    aiMatch: false,
    lastPlaced: null,
    lastMove: null,
    record: loadRecord(),
    overTimer: null
  };

  const dieEls = [];
  const scoreCells = [Object.create(null), Object.create(null)];
  const summaryCells = { upper: [null, null], bonus: [null, null], yahtzee: [null, null], total: [null, null] };

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                       */
  /* ------------------------------------------------------------------ */
  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function randDie() {
    return 1 + Math.floor(Math.random() * 6);
  }

  function fmtDice(values) {
    return values.length ? values.join(' · ') : 'all five';
  }

  function catLabel(id) {
    const found = CATS.find(function (c) { return c.id === id; });
    return found ? found.label : id;
  }

  function countOf(n, singular) {
    return n + ' ' + singular + (n === 1 ? '' : 's');
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function announce(message) {
    if (!room.live) return;
    room.live.textContent = '';
    window.setTimeout(function () { room.live.textContent = message; }, 20);
  }

  function loadBool(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return fallback;
      return raw === '1';
    } catch (err) {
      return fallback;
    }
  }

  function saveBool(key, value) {
    try { window.localStorage.setItem(key, value ? '1' : '0'); } catch (err) { /* private mode */ }
  }

  function loadRecord() {
    try {
      const raw = window.localStorage.getItem('yahtzee.record.v1');
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && Number.isFinite(parsed.wins) && Number.isFinite(parsed.losses)) {
        return { wins: parsed.wins, losses: parsed.losses, ties: parsed.ties || 0 };
      }
    } catch (err) { /* ignore */ }
    return { wins: 0, losses: 0, ties: 0 };
  }

  function saveRecord() {
    try { window.localStorage.setItem('yahtzee.record.v1', JSON.stringify(state.record)); } catch (err) { /* ignore */ }
  }

  function humanOpen() {
    return E.openCategories(state.cards[PLAYER]);
  }

  function canPlayerScore() {
    return state.turn === PLAYER &&
      (state.phase === 'roll' || state.phase === 'score') &&
      state.hasRolled &&
      !state.busy;
  }

  function canPlayerHold() {
    return state.turn === PLAYER &&
      state.phase === 'roll' &&
      state.hasRolled &&
      state.rollsLeft > 0 &&
      !state.busy;
  }

  /* ------------------------------------------------------------------ */
  /* Dice DOM                                                            */
  /* ------------------------------------------------------------------ */
  function buildDice() {
    for (let i = 0; i < 5; i++) {
      (function (index) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'die is-empty is-static';
        b.setAttribute('aria-label', 'Empty die');
        b.addEventListener('click', function () { onDieClick(index); });
        room.diceTray.appendChild(b);
        dieEls.push(b);
      })(i);
    }
  }

  function paintPips(node, value) {
    node.innerHTML = '';
    if (!value) {
      node.classList.add('is-empty');
      delete node.dataset.value;
      return;
    }
    node.classList.remove('is-empty');
    node.dataset.value = String(value);
    const pips = DIE_PIPS[value];
    for (let i = 0; i < pips.length; i++) {
      const pip = document.createElement('span');
      pip.className = 'pip p' + pips[i];
      node.appendChild(pip);
    }
  }

  function renderDice() {
    const holdable = canPlayerHold();
    for (let i = 0; i < 5; i++) {
      const node = dieEls[i];
      const value = state.hasRolled ? state.dice[i] : 0;
      paintPips(node, value);
      const held = state.hasRolled && state.held[i];
      node.classList.toggle('is-held', held);
      node.classList.toggle('is-static', !holdable);
      node.setAttribute('aria-pressed', held ? 'true' : 'false');
      node.setAttribute('aria-label', value ? 'Die ' + value + (held ? ', held' : '') : 'Empty die');
      node.tabIndex = holdable ? 0 : -1;
      if (!holdable) node.setAttribute('aria-disabled', 'true');
      else node.removeAttribute('aria-disabled');
    }
  }

  /**
   * Tumble the chosen dice, then settle on `finalValues`.
   * Resolves false if a new game started while the animation was running.
   */
  function animateDice(finalValues, indices) {
    const myGame = state.gameId;
    const nodes = indices.map(function (i) { return dieEls[i]; });
    nodes.forEach(function (n) {
      n.classList.remove('is-held', 'just-landed');
      n.classList.add('is-rolling');
    });

    return new Promise(function (resolve) {
      let tick = 0;
      const timer = window.setInterval(function () {
        if (state.gameId !== myGame) {
          window.clearInterval(timer);
          nodes.forEach(function (n) { n.classList.remove('is-rolling'); });
          resolve(false);
          return;
        }
        tick++;
        nodes.forEach(function (n) { paintPips(n, randDie()); });
        if (tick >= 9) {
          window.clearInterval(timer);
          nodes.forEach(function (n) {
            n.classList.remove('is-rolling');
            n.classList.add('just-landed');
            window.setTimeout(function () { n.classList.remove('just-landed'); }, 320);
          });
          indices.forEach(function (i) {
            paintPips(dieEls[i], finalValues[i]);
          });
          resolve(true);
        }
      }, 42);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Scorecard DOM                                                       */
  /* ------------------------------------------------------------------ */
  function buildScorecard() {
    room.scoreBody.innerHTML = '';

    appendSection('Upper section');
    for (let i = 0; i < 6; i++) addCategoryRow(CATS[i]);
    addSummaryRow('upper', 'Upper subtotal');
    addSummaryRow('bonus', 'Upper bonus');
    appendSection('Lower section');
    for (let i = 6; i < CATS.length; i++) addCategoryRow(CATS[i]);
    addSummaryRow('yahtzee', 'Yahtzee bonus');
    addTotalRow();
  }

  function appendSection(text) {
    const tr = document.createElement('tr');
    tr.className = 'section-row';
    const th = document.createElement('th');
    th.colSpan = 3;
    th.scope = 'colgroup';
    th.textContent = text;
    tr.appendChild(th);
    room.scoreBody.appendChild(tr);
  }

  function addCategoryRow(cat) {
    const tr = document.createElement('tr');
    tr.className = 'cat-row';
    tr.dataset.cat = cat.id;

    const th = document.createElement('th');
    th.scope = 'row';
    th.title = cat.hint;
    th.textContent = cat.label;
    tr.appendChild(th);

    for (let p = 0; p < 2; p++) {
      const td = document.createElement('td');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'score-cell is-open';
      btn.dataset.player = String(p);
      btn.dataset.cat = cat.id;
      btn.textContent = '·';
      btn.disabled = true;
      btn.addEventListener('click', function () { onScoreClick(p, cat.id); });
      td.appendChild(btn);
      tr.appendChild(td);
      scoreCells[p][cat.id] = btn;
    }

    room.scoreBody.appendChild(tr);
  }

  function addSummaryRow(key, label) {
    const tr = document.createElement('tr');
    tr.className = 'summary-row';
    tr.dataset.summary = key;
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = label;
    tr.appendChild(th);
    for (let p = 0; p < 2; p++) {
      const td = document.createElement('td');
      td.textContent = '—';
      tr.appendChild(td);
      summaryCells[key][p] = td;
    }
    room.scoreBody.appendChild(tr);
  }

  function addTotalRow() {
    const tr = document.createElement('tr');
    tr.className = 'total-row';
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = 'Total score';
    tr.appendChild(th);
    for (let p = 0; p < 2; p++) {
      const td = document.createElement('td');
      td.textContent = '0';
      tr.appendChild(td);
      summaryCells.total[p] = td;
    }
    room.scoreBody.appendChild(tr);
  }

  function renderScorecard() {
    const active = canPlayerScore();
    room.scorecard.classList.toggle('you-turn', state.phase !== 'over' && state.turn === PLAYER);
    room.scorecard.classList.toggle('cpu-turn', state.phase !== 'over' && state.turn === CPU);

    for (let p = 0; p < 2; p++) {
      const card = state.cards[p];
      for (let i = 0; i < CATS.length; i++) {
        const cat = CATS[i];
        const btn = scoreCells[p][cat.id];
        const scored = card.scores[cat.id] !== undefined;
        btn.classList.remove('is-open', 'is-filled', 'is-preview', 'is-active', 'is-zero', 'is-flash');
        btn.disabled = true;

        if (scored) {
          btn.textContent = String(card.scores[cat.id]);
          btn.classList.add('is-filled');
          if (card.scores[cat.id] === 0) btn.classList.add('is-zero');
          btn.setAttribute('aria-label', cat.label + ', ' + (p === 0 ? 'you' : 'computer') + ': ' + card.scores[cat.id]);
        } else if (p === PLAYER && active) {
          const preview = engine.scoreFor(cat.id, state.dice);
          btn.textContent = String(preview);
          btn.classList.add('is-preview', 'is-active');
          if (preview === 0) btn.classList.add('is-zero');
          btn.disabled = false;
          btn.setAttribute('aria-label', cat.label + ': score ' + preview + '. Click to bank it.');
        } else {
          btn.textContent = '·';
          btn.classList.add('is-open');
          btn.setAttribute('aria-label', cat.label + ', ' + (p === 0 ? 'you' : 'computer') + ': open');
        }

        if (state.lastPlaced && state.lastPlaced.player === p && state.lastPlaced.cat === cat.id) {
          btn.classList.add('is-flash');
        }
      }

      const upper = E.upperScore(card);
      const allUpper = CATS.slice(0, 6).every(function (c) { return card.scores[c.id] !== undefined; });
      summaryCells.upper[p].textContent = String(upper);

      const bonus = E.upperBonus(card);
      summaryCells.bonus[p].textContent = bonus ? '+35' : (allUpper ? '—' : upper + '/63');
      summaryCells.bonus[p].className = bonus ? 'is-earned' : 'is-pending';

      summaryCells.yahtzee[p].textContent = card.yahtzeeBonus ? '+' + card.yahtzeeBonus : '—';
      summaryCells.yahtzee[p].className = card.yahtzeeBonus ? 'is-earned' : 'is-pending';

      summaryCells.total[p].textContent = String(E.totalScore(card));
    }

  }

  /* ------------------------------------------------------------------ */
  /* Turn header and controls                                            */
  /* ------------------------------------------------------------------ */
  function renderTurn() {
    const over = state.phase === 'over';
    if (over) {
      room.turnName.textContent = 'Game over';
      room.rollsBadge.textContent = 'Final';
      room.statusDot.className = 'status-dot is-over';
    } else if (state.turn === CPU) {
      room.turnName.textContent = 'Computer’s turn';
      room.rollsBadge.textContent = state.rollsLeft + (state.rollsLeft === 1 ? ' roll left' : ' rolls left');
      room.statusDot.className = 'status-dot is-cpu';
    } else {
      room.turnName.textContent = 'Your turn';
      room.rollsBadge.textContent = state.rollsLeft + (state.rollsLeft === 1 ? ' roll left' : ' rolls left');
      room.statusDot.className = 'status-dot';
    }
  }

  function renderControls() {
    const over = state.phase === 'over';
    const isPlayer = state.turn === PLAYER && !over;

    if (over) {
      room.rollBtn.disabled = true;
      room.rollBtn.textContent = 'Game over';
      room.prompt.textContent = 'Start a new game to play again.';
      return;
    }

    if (!isPlayer) {
      room.rollBtn.disabled = true;
      room.rollBtn.textContent = state.busy ? 'Computer thinking' : 'Computer rolling';
      room.prompt.textContent = state.aiMatch
        ? 'The computer is weighing every dice outcome for match equity.'
        : 'The computer is enumerating every possible continuation of this turn.';
      return;
    }

    if (state.busy) {
      room.rollBtn.disabled = true;
      room.rollBtn.textContent = 'Rolling';
      room.prompt.textContent = 'Rolling the dice…';
      return;
    }

    if (state.rollsLeft === 0) {
      room.rollBtn.disabled = true;
      room.rollBtn.textContent = 'No rolls left';
      room.prompt.textContent = 'Pick a box on the scorecard to bank this roll.';
      return;
    }

    if (state.hasRolled && state.held.every(Boolean)) {
      room.rollBtn.disabled = true;
      room.rollBtn.textContent = 'All dice held';
      room.prompt.textContent = 'Every die is held. Bank a score, or unhold a die to reroll.';
      return;
    }

    room.rollBtn.disabled = false;
    room.rollBtn.textContent = state.hasRolled ? 'Roll again' : 'Roll dice';
    if (!state.hasRolled) {
      room.prompt.textContent = 'Roll to start your turn. Click a die to hold it between rolls.';
    } else if (state.rollsLeft === 1) {
      room.prompt.textContent = 'One roll left. Click dice to hold them, or bank a score now.';
    } else {
      room.prompt.textContent = 'Click dice to hold them, then roll again — or bank a score now.';
    }
  }

  function renderRecord() {
    if (!room.recordValue) return;
    const r = state.record;
    room.recordValue.textContent = r.wins + '–' + r.losses;
    room.record.title = 'You: ' + countOf(r.wins, 'win') + ' · CPU: ' + countOf(r.losses, 'win') +
      ' · ' + countOf(r.ties, 'tie');
    if (room.recordNote) {
      room.recordNote.textContent = (r.wins + r.losses + r.ties) === 0
        ? (engine.hasOptimalTable ? 'Exact play, with a match-aware endgame.' : 'Exact play, solved by dynamic programming.')
        : 'This browser: ' + r.wins + 'W · ' + r.losses + 'L · ' + r.ties + 'T';
    }
  }

  function renderAll() {
    renderTurn();
    renderDice();
    renderControls();
    renderScorecard();
    renderInsight();
  }

  /* ------------------------------------------------------------------ */
  /* Coach / computer insight                                            */
  /* ------------------------------------------------------------------ */
  function ensureCoachSolver() {
    if (state.turn !== PLAYER || !state.hasRolled) return null;
    const open = humanOpen();
    const card = state.cards[PLAYER];
    const signature = open.join(',') + '|' + E.upperScore(card) + '|' + (card.scores.yahtzee === 50 ? 'y' : 'n');
    if (!state.coachSolver || state.coachSignature !== signature) {
      state.coachSolver = engine.solve(open, card);
      state.coachSignature = signature;
    }
    return state.coachSolver;
  }

  function miniDice(values) {
    const wrap = el('div', 'mini-dice');
    if (!values || values.length === 0) {
      wrap.appendChild(el('span', 'mini-die none', 'all'));
      return wrap;
    }
    values.forEach(function (v) { wrap.appendChild(el('span', 'mini-die', String(v))); });
    return wrap;
  }

  function setInsightHead(tag, note) {
    room.insightTag.textContent = tag;
    room.insightNote.textContent = note;
  }

  function appendLastMove() {
    if (!state.lastMove) return;
    const move = state.lastMove;
    const who = move.player === CPU ? 'Computer' : 'You';
    const bonus = move.bonus ? ' plus a +100 Yahtzee bonus' : '';
    const note = el('p', 'coach-alt', who + ' scored ' + move.score + ' in ' + catLabel(move.catId) + bonus + '.');
    room.insightBody.appendChild(note);
  }

  function renderInsight() {
    room.insightBody.innerHTML = '';

    if (state.phase === 'over') {
      setInsightHead('Final', 'the board is complete');
      const wrap = el('div', 'coach');
      const row = el('div', 'coach-row');
      row.appendChild(el('span', 'coach-label', 'Result'));
      const you = E.totalScore(state.cards[PLAYER]);
      const cpu = E.totalScore(state.cards[CPU]);
      row.appendChild(el('span', 'coach-choice', 'You ' + you + ' · CPU ' + cpu));
      row.appendChild(el('span', 'coach-value', you === cpu ? 'tie' : you > cpu ? 'you win' : 'cpu wins'));
      wrap.appendChild(row);
      room.insightBody.appendChild(wrap);
      return;
    }

    if (state.phase === 'ai') {
      renderAiInsight();
      return;
    }

    if (!state.hasRolled) {
      setInsightHead(state.coach ? 'Coach' : 'Your move', state.coach ? 'exact probabilities' : 'click a die to hold it');
      const hint = el('p', 'insight-hint');
      if (state.coach) {
        hint.innerHTML = 'Roll the dice and the coach will show the <b>optimal hold</b>, the best box to bank, and your current odds of the 35-point upper bonus. All of it comes from enumerating every outcome.';
      } else {
        hint.innerHTML = 'You get up to three rolls. Click dice to hold them between rolls, then click any open box on the scorecard to bank your score.';
      }
      room.insightBody.appendChild(hint);
      appendLastMove();
      return;
    }

    if (!state.coach) {
      setInsightHead('Your move', 'coach is off');
      const hint = el('p', 'insight-hint');
      hint.innerHTML = 'Each open box shows what it would pay with this roll. Turn the coach back on for the optimal hold and the bonus odds.';
      room.insightBody.appendChild(hint);
      return;
    }

    const solver = ensureCoachSolver();
    if (!solver) return;
    const card = state.cards[PLAYER];
    const open = humanOpen();
    const best = solver.bestKeep(state.dice, state.rollsLeft);
    const choice = solver.bestCategory(state.dice);
    if (!best || !choice) return;

    const size = solver.searchSize(state.dice);
    setInsightHead('Coach', state.rollsLeft > 0 && size
      ? size.holds + ' holds · ' + size.outcomes.toLocaleString('en-US') + ' outcomes'
      : 'no rolls left');

    const wrap = el('div', 'coach');

    const holdRow = el('div', 'coach-row');
    holdRow.appendChild(el('span', 'coach-label', state.rollsLeft > 0 ? 'Optimal hold' : 'Best line'));
    if (state.rollsLeft > 0) {
      holdRow.appendChild(miniDice(best.values));
      if (best.holdAll) holdRow.appendChild(el('span', 'coach-value', 'keep all 5'));
    } else {
      holdRow.appendChild(el('span', 'coach-choice', 'Bank this roll'));
    }
    wrap.appendChild(holdRow);

    const scoreRow = el('div', 'coach-row');
    scoreRow.appendChild(el('span', 'coach-label', state.rollsLeft > 0 ? 'If you stop' : 'Best box'));
    scoreRow.appendChild(el('span', 'coach-choice', catLabel(choice.catId)));
    scoreRow.appendChild(el('span', 'coach-points', '+' + choice.score));
    wrap.appendChild(scoreRow);

    const bonusChance = engine.bonusChance(open, card);
    const upper = E.upperScore(card);
    const bonusRow = el('div', 'coach-row');
    bonusRow.appendChild(el('span', 'coach-label', 'Upper bonus'));
    const meter = el('div', 'bonus-meter');
    const track = el('div', 'meter-track');
    const fill = el('div', 'meter-fill');
    fill.style.width = Math.min(100, Math.round((upper / 63) * 100)) + '%';
    track.appendChild(fill);
    meter.appendChild(track);
    meter.appendChild(el('span', 'meter-label', upper + '/63'));
    bonusRow.appendChild(meter);
    bonusRow.appendChild(el('span', 'coach-value', Math.round(bonusChance * 100) + '% odds'));
    wrap.appendChild(bonusRow);

    const options = solver.keepOptions(state.dice, state.rollsLeft, 4);
    const alternatives = options.slice(1, 3);
    if (alternatives.length) {
      const alt = el('p', 'coach-alt');
      const bits = alternatives.map(function (opt) {
        return opt.values.length ? opt.values.join('·') : 'reroll all';
      });
      alt.innerHTML = 'Also solid: <b>' + bits.join('</b> · <b>') + '</b>.';
      wrap.appendChild(alt);
    } else {
      const alt = el('p', 'coach-alt', 'This is the only line that improves your expected total.');
      wrap.appendChild(alt);
    }

    if (engine.yahtzeeBonusFor(card, state.dice)) {
      wrap.appendChild(el('p', 'coach-alt', 'Extra Yahtzee — a +100 bonus will be added wherever you bank this roll.'));
    }

    room.insightBody.appendChild(wrap);
  }

  function renderAiInsight() {
    setInsightHead('Computer', state.aiMatch ? 'Match-W · exact win probability' : 'solving 7,776 outcomes');
    const wrap = el('div', 'ai-log');

    if (!state.aiLog.length) {
      const line = el('div', 'ai-line');
      line.appendChild(el('span', 'tag', 'Search'));
      const text = el('span', 'dice-vals', 'weighing every hold');
      line.appendChild(text);
      const dots = el('span', 'thinking-dots');
      dots.appendChild(el('i'));
      dots.appendChild(el('i'));
      dots.appendChild(el('i'));
      line.appendChild(dots);
      wrap.appendChild(line);
    } else {
      state.aiLog.forEach(function (entry) {
        const line = el('div', 'ai-line' + (entry.kind ? ' ' + entry.kind : ''));
        line.appendChild(el('span', 'tag', entry.tag));
        line.appendChild(el('span', 'dice-vals', entry.text));
        if (entry.ev) line.appendChild(el('span', 'ev', entry.ev));
        wrap.appendChild(line);
      });
      if (!state.aiFinal) {
        const line = el('div', 'ai-line');
        line.appendChild(el('span', 'tag', 'Search'));
        const dots = el('span', 'thinking-dots');
        dots.appendChild(el('i'));
        dots.appendChild(el('i'));
        dots.appendChild(el('i'));
        line.appendChild(dots);
        wrap.appendChild(line);
      }
    }

    room.insightBody.appendChild(wrap);

    if (state.aiFinal) {
      const final = el('div', 'ai-final');
      final.appendChild(el('span', '', 'Banks'));
      final.appendChild(el('span', 'cat-name', catLabel(state.aiFinal.catId)));
      if (state.aiFinal.bonus) final.appendChild(el('span', 'ev', '+' + state.aiFinal.bonus + ' bonus'));
      final.appendChild(el('span', 'score', String(state.aiFinal.score)));
      room.insightBody.appendChild(final);
    }
  }

  function aiLog(tag, text, ev, kind) {
    state.aiLog.push({ tag: tag, text: text, ev: ev || '', kind: kind || '' });
    renderInsight();
  }

  /* ------------------------------------------------------------------ */
  /* Game actions                                                       */
  /* ------------------------------------------------------------------ */
  function startNewGame() {
    resetNewGameButton();
    if (matchSolver) matchSolver.clear();
    state.gameId++;
    state.cards = [E.blankCard(), E.blankCard()];
    state.turn = PLAYER;
    state.phase = 'roll';
    state.rollsLeft = 3;
    state.dice = [0, 0, 0, 0, 0];
    state.held = [false, false, false, false, false];
    state.hasRolled = false;
    state.busy = false;
    state.coachSolver = null;
    state.coachSignature = '';
    state.aiLog = [];
    state.aiFinal = null;
    state.aiMatch = false;
    state.lastPlaced = null;
    state.lastMove = null;
    if (state.overTimer) { window.clearTimeout(state.overTimer); state.overTimer = null; }
    closeModal('overModal');
    announce('New game. You go first.');
    beginTurn();
  }

  function beginTurn() {
    state.rollsLeft = 3;
    state.dice = [0, 0, 0, 0, 0];
    state.held = [false, false, false, false, false];
    state.hasRolled = false;
    state.busy = state.turn === CPU;
    state.phase = state.turn === PLAYER ? 'roll' : 'ai';
    state.coachSolver = null;
    state.coachSignature = '';
    state.aiLog = [];
    state.aiFinal = null;
    state.aiMatch = false;
    renderAll();

    if (state.turn === CPU) {
      const myGame = state.gameId;
      runAiTurn(myGame).catch(function (err) {
        console.error('Computer turn failed', err);
        if (state.gameId !== myGame) return;
        state.busy = false;
        beginTurn();
      });
    }
  }

  async function playerRoll() {
    if (state.turn !== PLAYER || state.phase !== 'roll' || state.rollsLeft <= 0 || state.busy) return;
    if (state.hasRolled && state.held.every(Boolean)) return;
    const myGame = state.gameId;
    state.busy = true;
    renderControls();
    renderScorecard();

    const indices = state.hasRolled
      ? state.held.map(function (h, i) { return h ? -1 : i; }).filter(function (i) { return i >= 0; })
      : [0, 1, 2, 3, 4];
    const finalDice = state.dice.slice();
    indices.forEach(function (i) { finalDice[i] = randDie(); });

    const ok = await animateDice(finalDice, indices);
    if (!ok || state.gameId !== myGame) return;

    state.dice = finalDice;
    state.hasRolled = true;
    state.rollsLeft--;
    if (state.rollsLeft === 0) state.held = [false, false, false, false, false];
    state.phase = state.rollsLeft === 0 ? 'score' : 'roll';
    state.busy = false;
    ensureCoachSolver();
    announce('You rolled ' + fmtDice(state.dice) + '. ' + (state.rollsLeft ? state.rollsLeft + ' rolls left.' : 'Choose a box.'));
    renderAll();
  }

  async function aiRoll(indices, rollNo, myGame) {
    const finalDice = state.dice.slice();
    indices.forEach(function (i) { finalDice[i] = randDie(); });
    const ok = await animateDice(finalDice, indices);
    if (!ok || state.gameId !== myGame) return false;
    state.dice = finalDice;
    state.hasRolled = true;
    state.rollsLeft--;
    state.held = [false, false, false, false, false];
    aiLog('Roll ' + rollNo, fmtDice(finalDice));
    renderDice();
    renderScorecard();
    return true;
  }

  async function runAiTurn(myGame) {
    state.busy = true;
    state.rollsLeft = 3;
    state.dice = [0, 0, 0, 0, 0];
    state.held = [false, false, false, false, false];
    state.hasRolled = false;
    state.aiLog = [];
    state.aiFinal = null;
    state.aiMatch = false;
    renderAll();

    await sleep(550);
    if (state.gameId !== myGame) return;

    const card = state.cards[CPU];
    const first = await aiRoll([0, 1, 2, 3, 4], 1, myGame);
    if (!first) return;
    await sleep(ROLL_SETTLE);
    if (state.gameId !== myGame) return;

    const open = E.openCategories(card);
    const round = 14 - open.length;
    let solver = null;
    if (round >= MATCH_W_START_ROUND && matchSolver) {
      try {
        solver = matchSolver.turnFromCards(card, state.cards[PLAYER], round);
        state.aiMatch = true;
        renderControls();
      } catch (err) {
        console.warn('Match-W endgame failed; falling back to Exact-W.', err);
      }
    }
    if (!solver) solver = engine.solve(open, card);

    if (state.aiMatch) {
      aiLog('Match-W', 'exact P(win) + ½ P(tie)');
      await sleep(220);
      if (state.gameId !== myGame) return;
    }

    const size = solver.searchSize(state.dice);
    if (size) {
      aiLog('Search', size.holds + ' holds · ' + size.outcomes.toLocaleString('en-US') + ' outcomes');
      await sleep(320);
      if (state.gameId !== myGame) return;
    }

    let rollsLeft = 2;

    while (rollsLeft > 0) {
      const decision = solver.bestKeep(state.dice, rollsLeft);
      if (!decision) break;
      if (decision.holdAll) {
        aiLog('Stands', 'keeps all five dice');
        break;
      }

      aiLog('Hold', fmtDice(decision.values));
      state.held = decision.hold.slice();
      renderDice();
      await sleep(HOLD_DELAY);
      if (state.gameId !== myGame) return;

      const reroll = decision.hold.map(function (h, i) { return h ? -1 : i; }).filter(function (i) { return i >= 0; });
      const ok = await aiRoll(reroll, 4 - rollsLeft, myGame);
      if (!ok) return;
      rollsLeft--;
      renderDice();
      await sleep(ROLL_SETTLE);
      if (state.gameId !== myGame) return;
    }

    const choice = solver.bestCategory(state.dice);
    if (!choice) return;
    const bonus = engine.yahtzeeBonusFor(card, state.dice);
    state.aiFinal = { catId: choice.catId, score: choice.score, bonus: bonus };
    renderInsight();
    await sleep(700);
    if (state.gameId !== myGame) return;

    commitScore(CPU, choice.catId);
  }

  function onDieClick(index) {
    if (!canPlayerHold()) return;
    state.held[index] = !state.held[index];
    renderDice();
    renderControls();
    renderInsight();
  }

  function onScoreClick(player, catId) {
    if (player !== PLAYER || state.turn !== PLAYER) return;
    if (!canPlayerScore()) return;
    if (state.cards[PLAYER].scores[catId] !== undefined) return;
    commitScore(PLAYER, catId);
  }

  function commitScore(player, catId) {
    const myGame = state.gameId;
    const card = state.cards[player];
    const dice = state.dice.slice();
    const bonus = engine.yahtzeeBonusFor(card, dice);
    const score = engine.scoreFor(catId, dice);

    if (bonus) card.yahtzeeBonus += bonus;
    card.scores[catId] = score;
    state.lastPlaced = { player: player, cat: catId };
    state.lastMove = { player: player, catId: catId, score: score, bonus: bonus };
    state.busy = true;

    announce((player === PLAYER ? 'You scored ' : 'Computer scored ') + score + ' in ' + catLabel(catId) +
      (bonus ? ', plus a 100 point Yahtzee bonus' : '') + '.');

    window.setTimeout(function () {
      if (state.gameId === myGame && state.lastPlaced && state.lastPlaced.cat === catId) {
        state.lastPlaced = null;
        renderScorecard();
      }
    }, 1500);

    const finished = state.cards.every(function (c) { return E.isCardComplete(c); });
    if (finished) {
      state.phase = 'over';
      state.busy = false;
      renderAll();
      finishGame(myGame);
      return;
    }

    state.turn = player === PLAYER ? CPU : PLAYER;
    state.busy = false;
    beginTurn();
  }

  function finishGame(myGame) {
    if (matchSolver) matchSolver.clear();
    const you = E.totalScore(state.cards[PLAYER]);
    const cpu = E.totalScore(state.cards[CPU]);
    if (you > cpu) state.record.wins++;
    else if (cpu > you) state.record.losses++;
    else state.record.ties++;
    saveRecord();
    renderRecord();

    if (state.overTimer) window.clearTimeout(state.overTimer);
    state.overTimer = window.setTimeout(function () {
      if (state.gameId !== myGame) return;
      showGameOver();
    }, 900);
  }

  function showGameOver() {
    const you = E.totalScore(state.cards[PLAYER]);
    const cpu = E.totalScore(state.cards[CPU]);
    const win = you > cpu;
    const tie = you === cpu;

    room.overEyebrow.textContent = tie ? 'A dead heat' : win ? 'Victory' : 'Defeat';
    room.overTitle.textContent = tie ? 'A tie.' : win ? 'You win.' : 'The computer wins.';
    room.finalScores.innerHTML = '';

    [['You', you, win], ['CPU', cpu, !win && !tie]].forEach(function (row) {
      const box = el('div', 'final-score' + (row[2] ? ' is-winner' : ''));
      box.appendChild(el('span', 'who', row[0]));
      box.appendChild(el('span', 'num', String(row[1])));
      room.finalScores.appendChild(box);
    });

    const detail = [
      summaryLine('You', state.cards[PLAYER]),
      summaryLine('CPU', state.cards[CPU])
    ];
    room.finalDetail.innerHTML = detail.join('<br>');

    openModal('overModal');
    window.setTimeout(function () { room.playAgain.focus(); }, 30);
  }

  function summaryLine(who, card) {
    const upper = E.upperScore(card);
    const bonus = E.upperBonus(card);
    const lower = E.lowerScore(card);
    const y = card.yahtzeeBonus || 0;
    let out = who + ': upper ' + upper + (bonus ? ' (+35 bonus)' : '') + ' · lower ' + lower;
    if (y) out += ' · Yahtzee +' + y;
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Modals                                                             */
  /* ------------------------------------------------------------------ */
  let lastFocus = null;
  let newGameArmed = false;
  let newGameTimer = null;

  function resetNewGameButton() {
    newGameArmed = false;
    if (newGameTimer) {
      window.clearTimeout(newGameTimer);
      newGameTimer = null;
    }
    room.newBtn.textContent = 'New game';
    room.newBtn.classList.remove('is-confirming');
  }

  function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    lastFocus = document.activeElement;
    modal.hidden = false;
    const focusable = modal.querySelector('button');
    if (focusable) window.setTimeout(function () { focusable.focus(); }, 20);
  }

  function closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.hidden = true;
    if (lastFocus && typeof lastFocus.focus === 'function') {
      lastFocus.focus();
      lastFocus = null;
    }
  }

  function closeAllModals() {
    ['rulesModal', 'overModal'].forEach(function (id) {
      const modal = document.getElementById(id);
      if (modal && !modal.hidden) closeModal(id);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Wiring                                                             */
  /* ------------------------------------------------------------------ */
  function setCoach(on) {
    state.coach = on;
    saveBool('yahtzee.coach.v1', on);
    room.coachBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    room.coachBtn.textContent = on ? 'Coach on' : 'Coach off';
    renderInsight();
  }

  function init() {
    buildDice();
    buildScorecard();
    renderRecord();

    room.rollBtn.addEventListener('click', function () { playerRoll(); });
    room.coachBtn.addEventListener('click', function () { setCoach(!state.coach); });
    room.coachBtn.setAttribute('aria-pressed', state.coach ? 'true' : 'false');
    room.coachBtn.textContent = state.coach ? 'Coach on' : 'Coach off';

    room.rulesBtn.addEventListener('click', function () { openModal('rulesModal'); });
    room.newBtn.addEventListener('click', function () {
      if (state.phase !== 'over' && hasAnyScore() && !newGameArmed) {
        newGameArmed = true;
        room.newBtn.textContent = 'Tap again to restart';
        room.newBtn.classList.add('is-confirming');
        if (newGameTimer) window.clearTimeout(newGameTimer);
        newGameTimer = window.setTimeout(resetNewGameButton, 3500);
        return;
      }
      resetNewGameButton();
      startNewGame();
    });
    room.playAgain.addEventListener('click', function () { startNewGame(); });

    document.querySelectorAll('[data-close]').forEach(function (btn) {
      btn.addEventListener('click', function () { closeModal(btn.dataset.close); });
    });
    document.querySelectorAll('.modal').forEach(function (modal) {
      modal.addEventListener('click', function (event) {
        if (event.target === modal) closeModal(modal.id);
      });
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeAllModals();
    });

    beginTurn();

    window.setTimeout(function () {
      room.loading.classList.add('is-done');
    }, 120);
  }

  function hasAnyScore() {
    return state.cards.some(function (card) { return Object.keys(card.scores).length > 0; });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
