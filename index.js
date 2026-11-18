/**
 * 因果回响 (Karma Echo) - SillyTavern Extension
 *
 * 视觉风格：新中式极简 × 现代半透明毛玻璃仪表盘
 * 核心机制：
 * 1. 识别正文内容 + 世界书（World Info）设定与角色前史，自动判定角色正向/负面因果。
 * 2. 混合判定引擎：支持【正文末尾隐藏 <karma> 标签解析（零额外Token）】与【后台静默 AI / 独立副模型判定】。
 * 3. 延时概率清算（剧情回旋镖）：
 *    - 每次善恶行为生成一枚“因果伏笔（Causal Seed）”，先经历潜伏期酝酿。
 *    - 潜伏期满后，随累积数值与拖延回合数递增触发概率。
 *    - 检定命中（或手动触发）时，自动调出过往具体事件注入下一轮生成，形成贴合世界观的报应反噬或正向回馈。
 */

const MODULE_NAME = 'st_karma_cycle';
const PROMPT_KEY_DIRECTOR = 'st_karma_cycle_director';
const PROMPT_KEY_INLINE_RULE = 'st_karma_cycle_inline_rule';

// 远山水墨（页眉与空状态装饰）
const INK_MOUNTAIN_SVG = `<svg class="ke-ink-mountains" viewBox="0 0 600 120" preserveAspectRatio="none" aria-hidden="true">
    <defs>
        <linearGradient id="keInkFar" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#ece4d3" stop-opacity="0.10"/>
            <stop offset="1" stop-color="#ece4d3" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="keInkNear" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#ece4d3" stop-opacity="0.16"/>
            <stop offset="1" stop-color="#ece4d3" stop-opacity="0"/>
        </linearGradient>
    </defs>
    <circle cx="468" cy="34" r="15" fill="#c8463a" fill-opacity="0.22"/>
    <path d="M0 120 L0 84 C40 76 70 56 104 60 C132 63 150 40 182 36 C214 32 236 66 268 68 C300 70 318 46 352 44 C390 42 410 74 446 76 C480 78 506 52 540 54 C566 56 584 70 600 68 L600 120 Z" fill="url(#keInkFar)"/>
    <path d="M0 120 L0 100 C30 98 52 82 84 84 C120 86 140 68 176 66 C206 64 230 88 262 92 C296 96 322 76 356 74 C392 72 420 94 456 96 C494 98 520 82 556 84 C578 85 592 94 600 94 L600 120 Z" fill="url(#keInkNear)"/>
</svg>`;

// 朱砂印章（传统右起竖读：因果 / 回响）
const BRAND_SEAL_HTML = `<div class="ke-brand-seal" aria-hidden="true"><span>回</span><span>因</span><span>响</span><span>果</span></div>`;

function formatKarma(n) {
    const v = Math.round(Number(n) || 0);
    if (v > 0) return `+${v}`;
    if (v < 0) return `−${Math.abs(v)}`;
    return '0';
}

function karmaTone(n, deadZone = 15) {
    if (n >= deadZone) return 'good';
    if (n <= -deadZone) return 'evil';
    return 'neutral';
}

const DEFAULT_SETTINGS = {
    enabled: true,
    showFab: true,
    showChatBadge: true,
    stripInlineTag: true,

    // 判定模式: 'hybrid' | 'inline' | 'quiet'
    judgeMode: 'hybrid',
    judgeInterval: 1,       // 每 N 次 AI 回复做一次后台判定
    judgeMaxChars: 8000,    // 单次判定最多读取的剧情字数（超出时优先保留最新楼层）
    includeWorldInfo: true,
    maxWorldInfoChars: 3000,   // 每回合判定时附带的世界书字数上限
    scanWorldInfoChars: 12000, // 开局扫描时交给模型阅读的世界书字数上限

    // 延时概率检定参数
    latentTurns: 3,         // 潜伏回合数
    cooldownTurns: 4,       // 两次触发之间的冷却回合数
    triggerThreshold: 25,   // 起检阈值
    baseTriggerChance: 15,  // 达标基础触发率 (%)
    karmaWeight: 1.2,       // 每超出阈值 1 点增加的触发率 (%)
    turnWeight: 8,          // 每多拖延 1 回合增加的触发率 (%)
    settleRatio: 0.75,      // 每次结算核销比例 (0~1)

    // 导演指令注入设置
    injectPosition: 1,
    injectDepth: 1,
    injectRole: 0,
    injectAuraSummary: true,

    // 独立副模型 API（可选）
    useCustomApi: false,
    customApiUrl: 'https://api.openai.com/v1',
    customApiKey: '',
    customApiModel: 'gpt-4o-mini',
};

let stWorldInfoModule = null;

function getSTContext() {
    if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') {
        return SillyTavern.getContext();
    }
    return window;
}

async function ensureWorldInfoModule() {
    if (stWorldInfoModule) return stWorldInfoModule;
    const candidatePaths = [
        '../../../world-info.js',
        '../../world-info.js',
        '/scripts/world-info.js',
    ];
    for (const path of candidatePaths) {
        try {
            stWorldInfoModule = await import(path);
            if (stWorldInfoModule) return stWorldInfoModule;
        } catch (_) {
            // 继续尝试下一个路径
        }
    }
    return null;
}

function getSettings() {
    const ctx = getSTContext();
    if (!ctx.extensionSettings) {
        ctx.extensionSettings = {};
    }
    if (!ctx.extensionSettings[MODULE_NAME]) {
        ctx.extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    } else {
        for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
            if (ctx.extensionSettings[MODULE_NAME][k] === undefined) {
                ctx.extensionSettings[MODULE_NAME][k] = v;
            }
        }
    }
    return ctx.extensionSettings[MODULE_NAME];
}

function saveSettings() {
    const ctx = getSTContext();
    if (typeof ctx.saveSettingsDebounced === 'function') {
        ctx.saveSettingsDebounced();
    }
}

function createEmptyLedger() {
    return {
        turnCounter: 0,
        lastJudgedMessageId: -1,
        characters: {},
        pendingSettlements: [],
        historyLogs: [],
        worldLoreScanned: false,
    };
}

function createCharacterRecord(name) {
    return {
        name,
        totalKarma: 0,
        goodAccumulated: 0,
        evilAccumulated: 0,
        lastSettlementTurn: -999,
        currentRollChance: 0,
        statusTags: [],
        seeds: [],
    };
}

function getChatLedger() {
    const ctx = getSTContext();
    if (!ctx.chatMetadata) {
        ctx.chatMetadata = {};
    }
    if (!ctx.chatMetadata[MODULE_NAME]) {
        ctx.chatMetadata[MODULE_NAME] = createEmptyLedger();
    }
    const ledger = ctx.chatMetadata[MODULE_NAME];
    if (!ledger.characters) ledger.characters = {};
    if (!Array.isArray(ledger.pendingSettlements)) ledger.pendingSettlements = [];
    if (!Array.isArray(ledger.historyLogs)) ledger.historyLogs = [];
    if (typeof ledger.repliesSinceJudge !== 'number') ledger.repliesSinceJudge = 0;
    if (typeof ledger.lastJudgedChatIndex !== 'number') {
        // 新建账本 / 旧版本升级：已有楼层视为“已看过”，从之后的新楼层开始判定，避免把整段旧聊天重算一遍
        ledger.lastJudgedChatIndex = (typeof ledger.lastJudgedMessageId === 'number' && ledger.lastJudgedMessageId >= 0)
            ? ledger.lastJudgedMessageId
            : (Array.isArray(ctx.chat) ? ctx.chat.length - 1 : -1);
    }
    if (typeof ledger.turnCounter !== 'number') {
        ledger.turnCounter = Array.isArray(ctx.chat) ? Math.max(0, ctx.chat.length) : 0;
    }
    return ledger;
}

async function saveChatLedger() {
    const ctx = getSTContext();
    if (typeof ctx.saveMetadataDebounced === 'function') {
        ctx.saveMetadataDebounced();
    } else if (typeof ctx.saveMetadata === 'function') {
        await ctx.saveMetadata();
    }
}

/**
 * 新中式克制风格状态词：去修仙中二化，适配现代/西幻/古风全题材
 */
function getKarmaTierInfo(score) {
    const abs = Math.abs(score);
    const isGood = score >= 0;

    if (abs < 15) {
        return {
            title: '平澜',
            aura: '因果均衡，暂无明显偏向',
            severityName: '微澜',
            severityLevel: 0,
        };
    }
    if (abs < 40) {
        return {
            title: isGood ? '微光' : '暗瑕',
            aura: isGood ? '善意留痕，偶有顺遂' : '隐患初埋，易生波折',
            severityName: isGood ? '顺水回馈' : '小挫吃瘪',
            severityLevel: 1,
        };
    }
    if (abs < 70) {
        return {
            title: isGood ? '积善' : '负累',
            aura: isGood ? '信义加身，易得助力' : '前债未清，暗流潜伏',
            severityName: isGood ? '意外转机' : '败露反噬',
            severityLevel: 2,
        };
    }
    if (abs < 100) {
        return {
            title: isGood ? '澄明' : '临渊',
            aura: isGood ? '善果深厚，逢凶化吉' : '恶果累积，危机四伏',
            severityName: isGood ? '重磅机缘' : '重大危机',
            severityLevel: 3,
        };
    }
    return {
        title: isGood ? '圆满' : '倾覆',
        aura: isGood ? '大善回响，绝处逢生' : '因果崩塌，必遭重创',
        severityName: isGood ? '命运厚馈' : '彻底清算',
        severityLevel: 4,
    };
}

/**
 * 世界书读取策略（交给 LLM 理解，而不是关键词过滤）
 * - 每回合判定：使用酒馆本轮生成时“实际激活”的世界书条目（由酒馆自身的关键词/常驻规则决定，与主模型看到的一致）
 * - 开局扫描：读取所有已启用世界书的全部条目，整体交给 LLM 阅读并提炼角色前史
 */
let lastActivatedWorldInfo = [];

function normalizeWorldInfoEntry(e) {
    const keyText = Array.isArray(e.key) ? e.key.join(',') : (e.key || '');
    return {
        title: String(e.comment || keyText || '世界书条目').trim(),
        content: String(e.content || '').trim(),
        world: e.world || '',
        constant: Boolean(e.constant),
    };
}

function onWorldInfoActivated(entries) {
    if (!Array.isArray(entries)) return;
    lastActivatedWorldInfo = entries
        .filter(e => e && !e.disable && String(e.content || '').trim())
        .map(normalizeWorldInfoEntry);
    updateWorldInfoStatus();
}

function updateWorldInfoStatus() {
    const el = document.getElementById('st-karma-wi-status');
    if (!el) return;
    const n = lastActivatedWorldInfo.length;
    el.textContent = n > 0
        ? `上一轮酒馆激活了 ${n} 条世界书条目，会随剧情一起交给模型判定。`
        : '自动读取酒馆每轮实际激活的世界书条目，无需配置关键词。';
}

function formatWorldInfoEntries(entries, budget, perEntry) {
    const lines = [];
    let used = 0;
    for (const e of entries) {
        const body = e.content.length > perEntry ? `${e.content.slice(0, perEntry)}…` : e.content;
        const line = `[${e.title}] ${body}`;
        if (used + line.length > budget) continue;
        lines.push(line);
        used += line.length + 1;
    }
    return { text: lines.join('\n'), count: lines.length, total: entries.length };
}

async function collectAllWorldInfoEntries() {
    const wiMod = await ensureWorldInfoModule();
    if (typeof wiMod?.getSortedEntries !== 'function') return [];
    try {
        const raw = await wiMod.getSortedEntries();
        return (raw || [])
            .filter(e => e && !e.disable && String(e.content || '').trim())
            .map(normalizeWorldInfoEntry);
    } catch (e) {
        console.warn('[KarmaEcho] 读取世界书失败:', e);
        return [];
    }
}

function buildCharacterLore() {
    const ctx = getSTContext();
    try {
        const charId = ctx.characterId;
        const charObj = (ctx.characters && charId !== undefined) ? ctx.characters[charId] : null;
        if (!charObj) return '';
        const charDesc = [
            charObj.name ? `【主角色名】：${charObj.name}` : '',
            charObj.description ? `【角色设定】：${charObj.description.slice(0, 1200)}` : '',
            charObj.personality ? `【性格特征】：${charObj.personality.slice(0, 400)}` : '',
            charObj.scenario ? `【当前背景】：${charObj.scenario.slice(0, 600)}` : '',
        ].filter(Boolean).join('\n');
        return charDesc ? `=== 角色档案 ===\n${charDesc}` : '';
    } catch (e) {
        console.warn('[KarmaEcho] 读取角色卡失败:', e);
        return '';
    }
}

/**
 * 每回合判定用的设定上下文：角色卡 + 本轮激活的世界书
 */
async function buildTurnLoreContext() {
    const settings = getSettings();
    const parts = [buildCharacterLore()];

    if (settings.includeWorldInfo) {
        let entries = lastActivatedWorldInfo;
        if (entries.length === 0) {
            // 还没有发生过生成（例如刚打开聊天就手动判定）：退回到常驻条目
            entries = (await collectAllWorldInfoEntries()).filter(e => e.constant);
        }
        // 被剧情关键词触发的条目比常驻条目更贴近当前情节，排在前面
        const sorted = [...entries].sort((a, b) => Number(a.constant) - Number(b.constant));
        const { text } = formatWorldInfoEntries(sorted, Number(settings.maxWorldInfoChars) || 3000, 600);
        if (text) parts.push(`=== 本轮相关的世界书设定 ===\n${text}`);
    }

    return parts.filter(Boolean).join('\n\n');
}

/**
 * 开局扫描用的设定上下文：角色卡 + 所有已启用世界书的全部条目
 */
async function buildFullLoreContext() {
    const settings = getSettings();
    const parts = [buildCharacterLore()];
    let count = 0;
    let total = 0;

    if (settings.includeWorldInfo) {
        const all = await collectAllWorldInfoEntries();
        const res = formatWorldInfoEntries(all, Number(settings.scanWorldInfoChars) || 12000, 800);
        count = res.count;
        total = res.total;
        if (res.text) parts.push(`=== 世界书全部设定 ===\n${res.text}`);
    }

    return { text: parts.filter(Boolean).join('\n\n'), count, total };
}

/**
 * 记录一条新的因果伏笔事件
 */
function recordKarmaEvent(charName, delta, deed, options = {}) {
    if (!charName || !delta || isNaN(delta)) return null;
    const cleanName = String(charName).trim();
    if (!cleanName) return null;

    const settings = getSettings();
    const ledger = getChatLedger();
    const turn = ledger.turnCounter;

    if (!ledger.characters[cleanName]) {
        ledger.characters[cleanName] = createCharacterRecord(cleanName);
    }
    const charRec = ledger.characters[cleanName];

    const numDelta = Math.round(Number(delta));
    if (numDelta === 0) return null;

    charRec.totalKarma += numDelta;
    if (numDelta > 0) {
        charRec.goodAccumulated += numDelta;
    } else {
        charRec.evilAccumulated += Math.abs(numDelta);
    }

    const minDelay = options.minDelayTurns !== undefined
        ? Number(options.minDelayTurns)
        : Number(settings.latentTurns ?? 3);

    const seed = {
        id: `seed_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        character: cleanName,
        turn,
        delta: numDelta,
        remainingDelta: numDelta,
        deed: String(deed || (numDelta > 0 ? '正向善举' : '负面行为')).trim(),
        target: options.target ? String(options.target).trim() : '',
        ruleRef: options.ruleRef ? String(options.ruleRef).trim() : '',
        minDelayTurns: Math.max(0, minDelay),
        settled: false,
        settledTurn: null,
    };

    charRec.seeds.push(seed);
    if (charRec.seeds.length > 40) {
        charRec.seeds = charRec.seeds.slice(-40);
    }

    const tierInfo = getKarmaTierInfo(charRec.totalKarma);
    charRec.statusTags = [tierInfo.title];

    ledger.historyLogs.unshift({
        id: seed.id,
        type: 'seed',
        turn,
        character: cleanName,
        delta: numDelta,
        deed: seed.deed,
        ruleRef: seed.ruleRef,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
    if (ledger.historyLogs.length > 60) {
        ledger.historyLogs = ledger.historyLogs.slice(0, 60);
    }

    return seed;
}

/**
 * 计算角色的延时检定概率
 */
function calculateCharacterRoulette(charRec, currentTurn) {
    const settings = getSettings();
    const seeds = Array.isArray(charRec.seeds) ? charRec.seeds : [];

    let matureGood = 0;
    let matureEvil = 0;
    let latentGood = 0;
    let latentEvil = 0;
    let oldestMatureTurn = currentTurn;
    const matureEvilSeeds = [];
    const matureGoodSeeds = [];

    for (const s of seeds) {
        if (s.settled) continue;
        const rem = s.remainingDelta !== undefined ? s.remainingDelta : s.delta;
        if (!rem) continue;

        const turnsWaited = Math.max(0, currentTurn - (s.turn || 0));
        const requiredWait = s.minDelayTurns !== undefined ? s.minDelayTurns : settings.latentTurns;

        if (turnsWaited >= requiredWait) {
            if (rem > 0) {
                matureGood += rem;
                matureGoodSeeds.push(s);
            } else {
                matureEvil += Math.abs(rem);
                matureEvilSeeds.push(s);
            }
            if ((s.turn || 0) < oldestMatureTurn) {
                oldestMatureTurn = s.turn || 0;
            }
        } else {
            if (rem > 0) latentGood += rem;
            else latentEvil += Math.abs(rem);
        }
    }

    const turnsSinceLastSettle = currentTurn - (charRec.lastSettlementTurn ?? -999);
    const inCooldown = turnsSinceLastSettle < (settings.cooldownTurns ?? 4);

    const dominantType = matureEvil >= matureGood ? 'retribution' : 'blessing';
    const dominantValue = dominantType === 'retribution' ? matureEvil : matureGood;
    const dominantSeeds = dominantType === 'retribution' ? matureEvilSeeds : matureGoodSeeds;

    const threshold = Number(settings.triggerThreshold ?? 25);
    let triggerChance = 0;

    if (!inCooldown && dominantValue >= threshold) {
        const excessKarma = dominantValue - threshold;
        const overdueTurns = Math.max(0, currentTurn - oldestMatureTurn - (settings.latentTurns ?? 3));

        triggerChance = Math.min(
            100,
            Math.round(
                Number(settings.baseTriggerChance ?? 15) +
                excessKarma * Number(settings.karmaWeight ?? 1.2) +
                overdueTurns * Number(settings.turnWeight ?? 8)
            )
        );
    }

    charRec.currentRollChance = triggerChance;

    return {
        matureGood,
        matureEvil,
        latentGood,
        latentEvil,
        inCooldown,
        cooldownRemaining: Math.max(0, (settings.cooldownTurns ?? 4) - turnsSinceLastSettle),
        dominantType,
        dominantValue,
        dominantSeeds,
        triggerChance,
    };
}

/**
 * 为所有角色执行概率检定
 */
function rollKarmaRouletteForAll() {
    const settings = getSettings();
    if (!settings.enabled) return [];

    const ledger = getChatLedger();
    const currentTurn = ledger.turnCounter;
    const newlyTriggered = [];

    for (const charRec of Object.values(ledger.characters)) {
        if (ledger.pendingSettlements.some(p => p.character === charRec.name)) {
            continue;
        }

        const roulette = calculateCharacterRoulette(charRec, currentTurn);
        if (roulette.triggerChance <= 0) continue;

        const roll = Math.floor(Math.random() * 100) + 1;
        if (roll <= roulette.triggerChance) {
            const settlement = buildSettlementDirective(charRec, roulette, roll, false);
            if (settlement) {
                ledger.pendingSettlements.push(settlement);
                newlyTriggered.push(settlement);
            }
        }
    }

    return newlyTriggered;
}

/**
 * 构建全题材通用的【因果回响导演指令】
 */
function buildSettlementDirective(charRec, roulette, rollValue = 1, isManual = false) {
    const ledger = getChatLedger();
    const currentTurn = ledger.turnCounter;

    let targetSeeds = roulette.dominantSeeds;
    let direction = roulette.dominantType;
    let magnitude = roulette.dominantValue;

    if ((!targetSeeds || targetSeeds.length === 0) && isManual) {
        const unsettled = (charRec.seeds || []).filter(s => !s.settled && (s.remainingDelta || s.delta));
        const evilSeeds = unsettled.filter(s => (s.remainingDelta ?? s.delta) < 0);
        const goodSeeds = unsettled.filter(s => (s.remainingDelta ?? s.delta) > 0);
        const evilSum = evilSeeds.reduce((acc, s) => acc + Math.abs(s.remainingDelta ?? s.delta), 0);
        const goodSum = goodSeeds.reduce((acc, s) => acc + (s.remainingDelta ?? s.delta), 0);

        if (evilSum === 0 && goodSum === 0) {
            direction = charRec.totalKarma < 0 ? 'retribution' : 'blessing';
            magnitude = Math.max(30, Math.abs(charRec.totalKarma));
            targetSeeds = [];
        } else if (evilSum >= goodSum) {
            direction = 'retribution';
            magnitude = evilSum;
            targetSeeds = evilSeeds;
        } else {
            direction = 'blessing';
            magnitude = goodSum;
            targetSeeds = goodSeeds;
        }
    }

    const signedMagnitude = direction === 'retribution' ? -magnitude : magnitude;
    const tierInfo = getKarmaTierInfo(signedMagnitude);

    const deedSummaries = targetSeeds.slice(0, 5).map(s => {
        const turnLabel = s.turn ? `第${s.turn}回合` : '前史';
        const ruleNote = s.ruleRef ? `（关联：${s.ruleRef}）` : '';
        return `「${turnLabel}：${s.deed}${ruleNote}」`;
    });

    const deedsText = deedSummaries.length > 0
        ? deedSummaries.join('、')
        : (direction === 'retribution' ? '「此前积累的负面行为与亏欠」' : '「此前积累的善意与付出」');

    const promptInstruction = direction === 'retribution'
        ? `[因果回响导演指令 · 负面报应触发]
角色【${charRec.name}】此前曾有以下行为伏笔：${deedsText}，累积待结算负面分值达 ${magnitude}（反噬烈度：${tierInfo.severityName}）。
时机已成熟，请在本轮回复的剧情推进中，自然但明确地让【${charRec.name}】遭遇一次与上述过往行为相呼应的【现实反噬/回旋镖报应】！
叙事要求：
1. 表现方式必须严格贴合当前故事题材与现实逻辑（例如：隐瞒欺骗则真相败露或信任崩塌、算计他人则搬起石头砸自己的脚、违背规则或契约则承担相应代价、埋下的隐患在关键时刻爆发），严禁跨题材出现违和词汇。
2. 冲突烈度需匹配【${tierInfo.severityName}】，通过剧情细节形成前后呼应的宿命感，切勿在正文中直接提及任何数值或系统指令。`
        : `[因果回响导演指令 · 正向回馈触发]
角色【${charRec.name}】此前曾有以下正向伏笔：${deedsText}，累积待结算正向分值达 ${magnitude}（回馈等级：${tierInfo.severityName}）。
时机已成熟，请在本轮回复的剧情推进中，自然但明确地让【${charRec.name}】收获一次与上述过往善意或付出相呼应的【正向回馈/意外转机】！
叙事要求：
1. 表现方式必须严格贴合当前故事题材与人物关系逻辑（例如：曾帮助过的人在关键时刻伸出援手、守信重诺赢得关键信任或筹码、困境中迎来意想不到的转机或有利局面），严禁跨题材出现违和词汇。
2. 回馈程度需匹配【${tierInfo.severityName}】，让昔日种下的善因自然结出今日之果，切勿在正文中直接提及任何数值或系统指令。`;

    return {
        id: `settle_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        character: charRec.name,
        direction,
        magnitude,
        severityName: tierInfo.severityName,
        deedsText,
        seedIds: targetSeeds.map(s => s.id),
        rollValue,
        triggerChance: isManual ? 100 : roulette.triggerChance,
        createdTurn: currentTurn,
        promptInstruction,
    };
}

/**
 * 核销已完成触发的待结算队列
 */
function finalizePendingSettlements() {
    const settings = getSettings();
    const ledger = getChatLedger();
    if (!Array.isArray(ledger.pendingSettlements) || ledger.pendingSettlements.length === 0) {
        return;
    }

    const currentTurn = ledger.turnCounter;
    const ratio = Math.min(1, Math.max(0.1, Number(settings.settleRatio ?? 0.75)));

    for (const item of ledger.pendingSettlements) {
        const charRec = ledger.characters[item.character];
        if (charRec) {
            charRec.lastSettlementTurn = currentTurn;

            for (const seed of (charRec.seeds || [])) {
                if (item.seedIds.includes(seed.id) && !seed.settled) {
                    const rem = seed.remainingDelta !== undefined ? seed.remainingDelta : seed.delta;
                    const settledAmount = Math.round(rem * ratio);
                    seed.remainingDelta = rem - settledAmount;
                    charRec.totalKarma -= settledAmount;
                    if (Math.abs(seed.remainingDelta) <= 3 || ratio >= 0.95) {
                        seed.remainingDelta = 0;
                        seed.settled = true;
                        seed.settledTurn = currentTurn;
                    }
                }
            }

            calculateCharacterRoulette(charRec, currentTurn);
            const tierInfo = getKarmaTierInfo(charRec.totalKarma);
            charRec.statusTags = [tierInfo.title];
        }

        ledger.historyLogs.unshift({
            id: item.id,
            type: 'settlement',
            turn: currentTurn,
            character: item.character,
            direction: item.direction,
            magnitude: item.magnitude,
            severityName: item.severityName,
            deedsText: item.deedsText,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        });
    }

    ledger.pendingSettlements = [];
}

/**
 * 同步注入给酒馆的 Extension Prompts
 */
function syncExtensionPrompts() {
    const ctx = getSTContext();
    if (typeof ctx.setExtensionPrompt !== 'function') return;

    const settings = getSettings();
    if (!settings.enabled) {
        ctx.setExtensionPrompt(PROMPT_KEY_DIRECTOR, '', settings.injectPosition, settings.injectDepth, false, settings.injectRole);
        ctx.setExtensionPrompt(PROMPT_KEY_INLINE_RULE, '', settings.injectPosition, settings.injectDepth, false, settings.injectRole);
        return;
    }

    const ledger = getChatLedger();
    const directorBlocks = [];

    if (settings.injectAuraSummary) {
        const charSummaries = Object.values(ledger.characters)
            .filter(c => Math.abs(c.totalKarma) >= 15)
            .map(c => {
                const tier = getKarmaTierInfo(c.totalKarma);
                const sign = c.totalKarma > 0 ? `+${c.totalKarma}` : `${c.totalKarma}`;
                return `- ${c.name}：因果倾向 ${sign}（状态：${tier.title} · ${tier.aura}）`;
            });
        if (charSummaries.length > 0) {
            directorBlocks.push(`[因果回响 · 角色当前潜在处境参考]\n${charSummaries.join('\n')}`);
        }
    }

    if (Array.isArray(ledger.pendingSettlements) && ledger.pendingSettlements.length > 0) {
        for (const s of ledger.pendingSettlements) {
            directorBlocks.push(s.promptInstruction);
        }
    }

    const finalDirectorPrompt = directorBlocks.join('\n\n');
    ctx.setExtensionPrompt(
        PROMPT_KEY_DIRECTOR,
        finalDirectorPrompt,
        Number(settings.injectPosition ?? 1),
        Number(settings.injectDepth ?? 1),
        false,
        Number(settings.injectRole ?? 0)
    );

    if (settings.judgeMode === 'inline' || settings.judgeMode === 'hybrid') {
        const inlineRulePrompt = `[因果回响记录协议]
在每次正文回复的最末尾，请结合当前世界观准则评估出场角色在本轮是否有显著的正向行为（守信、助人、承担责任、真诚付出等）或负面行为（欺瞒、背叛、伤害无辜、算计利用、违背契约等）。
若有显著行为，请在正文结束后另起一行附上隐藏标签（若无明显善恶事件则输出 <karma>[]</karma>）：
<karma>[{"char":"角色名","delta":-20,"deed":"简述本回合结下的因果事件","rule":"关联的准则或原因","delay":3}]</karma>
（说明：delta 正数为正向积累 +5~+50，负数为负面积累 -5~-50；delay 为回旋镖潜伏回合数，常规为 2~5）`;

        ctx.setExtensionPrompt(
            PROMPT_KEY_INLINE_RULE,
            inlineRulePrompt,
            1,
            0,
            false,
            0
        );
    } else {
        ctx.setExtensionPrompt(PROMPT_KEY_INLINE_RULE, '', 1, 0, false, 0);
    }
}

/**
 * 解析并剥离正文中内嵌的 <karma> 标签
 */
function parseAndStripInlineKarmaTags(messageObj) {
    if (!messageObj || typeof messageObj.mes !== 'string') return [];

    const karmaRegex = /<karma>([\s\S]*?)<\/karma>/gi;
    const matches = [...messageObj.mes.matchAll(karmaRegex)];
    if (matches.length === 0) return [];

    const recordedEvents = [];
    for (const match of matches) {
        const rawInner = (match[1] || '').trim();
        if (!rawInner || rawInner === '[]') continue;

        const parsedList = tryParseKarmaJson(rawInner);
        for (const item of parsedList) {
            const charName = item.char || item.character || item.name;
            const delta = Number(item.delta ?? item.score ?? 0);
            const deed = item.deed || item.reason || item.event || '';
            const ruleRef = item.rule || item.ruleRef || '';
            const minDelayTurns = item.delay !== undefined ? Number(item.delay) : undefined;

            if (charName && delta !== 0) {
                const seed = recordKarmaEvent(charName, delta, deed, { ruleRef, minDelayTurns });
                if (seed) recordedEvents.push(seed);
            }
        }
    }

    const settings = getSettings();
    if (settings.stripInlineTag) {
        messageObj.mes = messageObj.mes.replace(karmaRegex, '').trim();
    }

    return recordedEvents;
}

function tryParseKarmaJson(rawText) {
    if (!rawText) return [];
    let cleaned = rawText
        .replace(/```json/gi, '')
        .replace(/```/g, '')
        .trim();

    const arrMatch = cleaned.match(/\[[\s\S]*\]/);
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (arrMatch) {
        cleaned = arrMatch[0];
    } else if (objMatch) {
        cleaned = `[${objMatch[0]}]`;
    }

    try {
        const data = JSON.parse(cleaned);
        if (Array.isArray(data)) return data;
        if (data && Array.isArray(data.events)) return data.events;
        if (data && typeof data === 'object') return [data];
    } catch (e) {
        console.warn('[KarmaEcho] JSON 解析失败:', rawText, e);
    }
    return [];
}

async function runLLMPrompt(promptText) {
    const settings = getSettings();

    if (settings.useCustomApi && settings.customApiUrl && settings.customApiKey) {
        const baseUrl = settings.customApiUrl.replace(/\/+$/, '');
        const endpoint = baseUrl.endsWith('/chat/completions')
            ? baseUrl
            : `${baseUrl}/chat/completions`;

        const resp = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.customApiKey.trim()}`,
            },
            body: JSON.stringify({
                model: settings.customApiModel || 'gpt-4o-mini',
                temperature: 0.2,
                messages: [
                    {
                        role: 'system',
                        content: '你是一个冷静克制的叙事因果分析引擎，只输出符合要求的纯 JSON 数组，不输出任何多余文字。',
                    },
                    {
                        role: 'user',
                        content: promptText,
                    },
                ],
            }),
        });

        if (!resp.ok) {
            throw new Error(`独立 API 请求失败 (${resp.status}): ${await resp.text()}`);
        }
        const data = await resp.json();
        return data?.choices?.[0]?.message?.content || '[]';
    }

    const ctx = getSTContext();
    if (typeof ctx.generateQuietPrompt === 'function') {
        return await ctx.generateQuietPrompt({ quietPrompt: promptText, quietToLoud: false, skipWIAN: true });
    }

    throw new Error('未找到可用的生成接口（generateQuietPrompt 不可用且未配置独立 API）。');
}

/**
 * 后台静默分析最新一轮剧情
 */
async function judgeLatestTurnWithAI(isManual = false, endIndex = null) {
    const ctx = getSTContext();
    const chat = ctx.chat || [];
    if (chat.length === 0) {
        if (isManual && typeof toastr !== 'undefined') {
            toastr.warning('当前暂无聊天内容可供分析。', '因果回响');
        }
        return [];
    }

    const settings = getSettings();
    const ledger = getChatLedger();
    const end = endIndex === null ? chat.length - 1 : endIndex;
    const batch = collectUnjudgedMessages(ledger, end, Number(settings.judgeMaxChars) || 8000);

    if (batch.count === 0) {
        // 范围内全是被隐藏的楼层：视为已处理，避免反复空跑
        ledger.lastJudgedChatIndex = batch.end;
        ledger.repliesSinceJudge = 0;
        if (isManual && typeof toastr !== 'undefined') {
            toastr.info('待判定的楼层都已被隐藏（总结插件/手动隐藏），已跳过。', '因果回响');
        }
        return [];
    }

    const worldLore = await buildTurnLoreContext();
    const recentMessages = batch.text;
    const rangeNote = `第 ${batch.from} ~ ${batch.end} 楼，共 ${batch.count} 条${batch.skippedHidden ? `，已跳过 ${batch.skippedHidden} 条隐藏楼层` : ''}`;
    const existingChars = Object.keys(ledger.characters).join('、') || '暂无记录';

    const judgePrompt = `请结合【角色与世界书设定】以及【待判定剧情】，客观分析这段剧情中是否有角色埋下了显著的正向善因或负面恶因。

${worldLore ? `${worldLore}\n\n` : ''}=== 已知在册角色 ===
${existingChars}

=== 待判定剧情（${rangeNote}） ===
${recentMessages}

=== 评估准则 ===
1. 依据故事所在世界观的规则、契约、人物关系伦理与普世价值进行评估：
   - 正向分（+5 到 +50）：危急相助、信守承诺、保护他人、坦诚担当、遵守关键契约或底线等。
   - 负面分（-5 到 -50）：欺瞒背叛、暗中算计、伤害无辜、转嫁灾祸、违背誓言或世界观禁忌等。
2. 只针对上面【待判定剧情】中新发生的行为计分，同一件事只记一次；之前已结算过的旧事不要重复统计。
3. 若这段剧情只是日常互动、无明显因果倾向，请直接返回空数组 []。
4. 仅输出纯 JSON 数组，格式如下：
[
  {
    "char": "角色姓名",
    "delta": -20,
    "deed": "简述具体事件（25字以内）",
    "rule": "关联准则或原因（15字以内）",
    "delay": 3
  }
]`;

    try {
        if (isManual && typeof toastr !== 'undefined') {
            toastr.info(`正在分析${rangeNote}……`, '因果回响');
        }
        const rawReply = await runLLMPrompt(judgePrompt);
        const items = tryParseKarmaJson(rawReply);
        const recorded = [];

        for (const item of items) {
            const charName = item.char || item.character || item.name;
            const delta = Number(item.delta ?? item.score ?? 0);
            const deed = item.deed || item.reason || '';
            const ruleRef = item.rule || '';
            const minDelayTurns = item.delay !== undefined ? Number(item.delay) : undefined;

            if (charName && delta !== 0) {
                const seed = recordKarmaEvent(charName, delta, deed, { ruleRef, minDelayTurns });
                if (seed) recorded.push(seed);
            }
        }

        // 判定成功才推进进度；失败的话这些楼层留到下次再判
        ledger.lastJudgedChatIndex = batch.end;
        ledger.repliesSinceJudge = 0;

        if (isManual && typeof toastr !== 'undefined') {
            if (recorded.length > 0) {
                toastr.success(`已记录 ${recorded.length} 条新的因果动态。`, '因果回响');
            } else {
                toastr.info('这段剧情暂无显著的善恶因果变动。', '因果回响');
            }
        }
        return recorded;
    } catch (err) {
        console.error('[KarmaEcho] 剧情分析出错:', err);
        if (isManual && typeof toastr !== 'undefined') {
            toastr.error(`分析失败: ${err.message}`, '因果回响');
        }
        return [];
    }
}

/**
 * 扫描世界书与角色前史，提取初始未结算因果
 */
async function scanWorldLoreForInitialKarma() {
    const { text: worldLore, count: wiCount, total: wiTotal } = await buildFullLoreContext();
    if (!worldLore || worldLore.trim().length < 10) {
        if (typeof toastr !== 'undefined') {
            toastr.warning('未读取到有效的角色卡设定或激活的世界书内容。', '因果回响');
        }
        return;
    }

    const scanPrompt = `请阅读以下【角色档案与世界书设定】，梳理出登场的主要角色，并根据他们在背景前史中的关键行为（例如：曾亏欠、背叛、隐瞒他人，或曾有救命之恩、守护付出等未了前事），建立初始的“待结算因果伏笔”。

${worldLore}

=== 输出要求 ===
仅输出纯 JSON 数组（语言需现代简洁，贴合故事原本题材）：
[
  {
    "char": "角色名",
    "delta": -30,
    "deed": "前史事件简述（如：三年前隐瞒真相导致同伴蒙冤）",
    "rule": "关联准则或前因",
    "delay": 2
  }
]`;

    try {
        if (typeof toastr !== 'undefined') {
            toastr.info(wiTotal > 0 ? `正在让模型通读 ${wiCount}/${wiTotal} 条世界书与角色卡……` : '正在让模型阅读角色卡……', '因果回响');
        }
        const rawReply = await runLLMPrompt(scanPrompt);
        const items = tryParseKarmaJson(rawReply);
        let count = 0;

        for (const item of items) {
            const charName = item.char || item.character || item.name;
            const delta = Number(item.delta ?? item.score ?? 0);
            const deed = item.deed || item.reason || '角色前史伏笔';
            const ruleRef = item.rule || '背景前史';
            const minDelayTurns = item.delay !== undefined ? Number(item.delay) : 2;

            if (charName && delta !== 0) {
                recordKarmaEvent(charName, delta, `[前史] ${deed}`, { ruleRef, minDelayTurns });
                count++;
            }
        }

        const ledger = getChatLedger();
        ledger.worldLoreScanned = true;
        for (const c of Object.values(ledger.characters)) {
            calculateCharacterRoulette(c, ledger.turnCounter);
        }
        await saveChatLedger();
        syncExtensionPrompts();
        renderModalIfOpen();
        updateFabBadge();

        if (typeof toastr !== 'undefined') {
            toastr.success(`扫描完成，已提取 ${count} 条角色前史伏笔。`, '因果回响');
        }
    } catch (err) {
        console.error('[KarmaEcho] 扫描前史失败:', err);
        if (typeof toastr !== 'undefined') {
            toastr.error(`扫描失败: ${err.message}`, '因果回响');
        }
    }
}

/**
 * 渲染聊天气泡底部轻量提示条
 */
function renderMessageKarmaBadge(messageId, recordedSeeds, triggeredSettlements) {
    const settings = getSettings();
    if (!settings.showChatBadge) return;
    if ((!recordedSeeds || recordedSeeds.length === 0) && (!triggeredSettlements || triggeredSettlements.length === 0)) {
        return;
    }

    const msgEl = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
    if (!msgEl) return;

    const oldBadge = msgEl.parentElement.querySelector('.st-karma-chat-badge');
    if (oldBadge) oldBadge.remove();

    const parts = [];
    for (const s of (recordedSeeds || [])) {
        const sign = s.delta > 0 ? `+${s.delta}` : `${s.delta}`;
        const cls = s.delta > 0 ? 'tag-good' : 'tag-evil';
        parts.push(`<span class="st-karma-tag ${cls}">${escapeHtml(s.character || '')} · ${escapeHtml(s.deed)} (${sign} / 潜伏${s.minDelayTurns}回合)</span>`);
    }

    for (const t of (triggeredSettlements || [])) {
        const label = t.direction === 'retribution' ? '报应已锁定' : '回馈已锁定';
        parts.push(`<span class="st-karma-tag tag-roulette">${label}：${escapeHtml(t.character)}（${escapeHtml(t.severityName)} · 下回合生效）</span>`);
    }

    const badge = document.createElement('div');
    badge.className = 'st-karma-chat-badge';
    badge.innerHTML = `<span class="st-karma-chat-badge-title">回响</span>${parts.join(' ')}`;
    msgEl.insertAdjacentElement('afterend', badge);
}

/**
 * 楼层是否被隐藏：总结插件 / 手动隐藏（👻）都会把楼层标记为 is_system，
 * 酒馆自己构建上下文时也是按这个标记排除的。
 */
function isHiddenMessage(m) {
    return !m || m.is_system === true;
}

function stripKarmaTags(text) {
    return String(text || '').replace(/<karma>[\s\S]*?<\/karma>/gi, '').trim();
}

/**
 * 收集“上次判定之后”到 endIndex 之间的未判定楼层（跳过隐藏楼层）
 * 超出字数预算时优先保留最新的楼层
 */
function collectUnjudgedMessages(ledger, endIndex, maxChars) {
    const chat = getSTContext().chat || [];
    const end = Math.min(endIndex, chat.length - 1);
    let start = (typeof ledger.lastJudgedChatIndex === 'number' ? ledger.lastJudgedChatIndex : -1) + 1;
    if (start > end) start = Math.max(0, end); // 没有新楼层（例如手动判定）：至少看最新一层

    const picked = [];
    let used = 0;
    let skippedHidden = 0;
    let from = end;

    for (let i = end; i >= start; i--) {
        const m = chat[i];
        if (isHiddenMessage(m)) {
            skippedHidden++;
            continue;
        }
        const line = `#${i} ${m.name || (m.is_user ? '玩家' : '角色')}：${stripKarmaTags(m.mes)}`;
        if (picked.length > 0 && used + line.length > maxChars) break;
        picked.unshift(line);
        used += line.length;
        from = i;
    }

    return { text: picked.join('\n\n---\n\n'), count: picked.length, skippedHidden, from, end };
}

/**
 * 收到 AI 消息时的钩子
 */
async function onMessageReceived(messageId) {
    const settings = getSettings();
    if (!settings.enabled) return;

    const ctx = getSTContext();
    const chat = ctx.chat || [];
    const msgIndex = typeof messageId === 'number' ? messageId : chat.length - 1;
    const messageObj = chat[msgIndex];
    if (!messageObj || messageObj.is_user || isHiddenMessage(messageObj)) return;

    const ledger = getChatLedger();
    if (ledger.lastJudgedMessageId === msgIndex) return;
    ledger.lastJudgedMessageId = msgIndex;
    ledger.turnCounter = (ledger.turnCounter || 0) + 1;
    ledger.repliesSinceJudge = (ledger.repliesSinceJudge || 0) + 1;

    if (Array.isArray(ledger.pendingSettlements) && ledger.pendingSettlements.length > 0) {
        finalizePendingSettlements();
    }

    let recordedSeeds = [];

    if (settings.judgeMode === 'inline' || settings.judgeMode === 'hybrid') {
        const hadTag = /<karma>[\s\S]*?<\/karma>/i.test(messageObj.mes || '');
        recordedSeeds = parseAndStripInlineKarmaTags(messageObj);
        if (settings.stripInlineTag) {
            const mesTextEl = document.querySelector(`.mes[mesid="${msgIndex}"] .mes_text`);
            if ((mesTextEl && mesTextEl.innerHTML.includes('&lt;karma&gt;')) || (mesTextEl && mesTextEl.textContent.includes('<karma>'))) {
                mesTextEl.innerHTML = mesTextEl.innerHTML
                    .replace(/&lt;karma&gt;[\s\S]*?&lt;\/karma&gt;/gi, '')
                    .replace(/<karma>[\s\S]*?<\/karma>/gi, '');
            }
        }
        // 主模型自己附带了标签（哪怕是空的 []），说明这一轮已经判过了
        if (hadTag || settings.judgeMode === 'inline') {
            ledger.lastJudgedChatIndex = msgIndex;
            ledger.repliesSinceJudge = 0;
        }
    }

    // 后台判定：每 N 次 AI 回复一次，一次性读完上次判定之后的所有未隐藏楼层
    const interval = Math.max(1, Number(settings.judgeInterval) || 1);
    if (settings.judgeMode !== 'inline' && ledger.repliesSinceJudge >= interval) {
        const quietSeeds = await judgeLatestTurnWithAI(false, msgIndex);
        recordedSeeds.push(...quietSeeds);
    }

    for (const [charName, charRec] of Object.entries(ledger.characters)) {
        for (const s of (charRec.seeds || [])) {
            if (!s.character) s.character = charName;
        }
    }

    const triggeredSettlements = rollKarmaRouletteForAll();

    if (triggeredSettlements.length > 0 && typeof toastr !== 'undefined') {
        for (const t of triggeredSettlements) {
            const title = t.direction === 'retribution' ? '因果回响 · 报应即将触发' : '因果回响 · 回馈即将触发';
            toastr.info(
                `角色【${t.character}】检定命中【${t.severityName}】（概率 ${t.triggerChance}%），将在下一回合剧情中自然呈现。`,
                title,
                { timeOut: 5500 }
            );
        }
    }

    await saveChatLedger();
    syncExtensionPrompts();
    renderMessageKarmaBadge(msgIndex, recordedSeeds, triggeredSettlements);
    updateFabBadge();
    renderModalIfOpen();
}

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function updateFabBadge() {
    const fab = document.getElementById('st-karma-fab');
    if (!fab) return;

    const settings = getSettings();
    fab.style.display = settings.showFab && settings.enabled ? 'flex' : 'none';

    const ledger = getChatLedger();
    const pendingCount = Array.isArray(ledger.pendingSettlements) ? ledger.pendingSettlements.length : 0;

    fab.classList.toggle('karma-fab-pending', pendingCount > 0);
    const badgeEl = fab.querySelector('.karma-fab-badge');
    if (badgeEl) {
        if (pendingCount > 0) {
            badgeEl.style.display = 'flex';
            badgeEl.textContent = String(pendingCount);
        } else {
            badgeEl.style.display = 'none';
        }
    }
}

function openKarmaModal() {
    const backdrop = document.getElementById('st-karma-modal-backdrop');
    if (!backdrop) return;
    backdrop.classList.add('karma-open');
    renderKarmaModalContent();
}

function closeKarmaModal() {
    const backdrop = document.getElementById('st-karma-modal-backdrop');
    if (!backdrop) return;
    backdrop.classList.remove('karma-open');
}

function renderModalIfOpen() {
    const backdrop = document.getElementById('st-karma-modal-backdrop');
    if (backdrop && backdrop.classList.contains('karma-open')) {
        renderKarmaModalContent();
    }
}

/**
 * 渲染主面板（新中式账簿视图）
 */
function renderKarmaModalContent() {
    const bodyEl = document.getElementById('st-karma-modal-body');
    if (!bodyEl) return;

    const settings = getSettings();
    const ledger = getChatLedger();
    const currentTurn = ledger.turnCounter || 0;
    const chars = Object.values(ledger.characters);

    const charRoulettes = {};
    for (const c of chars) {
        charRoulettes[c.name] = calculateCharacterRoulette(c, currentTurn);
    }

    // 1. 待生效告示
    let pendingHtml = '';
    if (ledger.pendingSettlements && ledger.pendingSettlements.length > 0) {
        const itemsHtml = ledger.pendingSettlements.map(p => {
            const typeLabel = p.direction === 'retribution' ? '报应' : '回馈';
            return `<div class="ke-notice-item">
                <div>
                    <b>${escapeHtml(p.character)}</b> · ${typeLabel}<span class="ke-muted">（${escapeHtml(p.severityName)}）</span>
                    <div class="ke-notice-deeds">${escapeHtml(p.deedsText)}</div>
                </div>
                <button class="st-karma-btn karma-btn-danger st-karma-cancel-pending" data-id="${escapeHtml(p.id)}">撤回</button>
            </div>`;
        }).join('');

        pendingHtml = `<div class="st-karma-pending-directive">
            <span class="ke-seal ke-seal-indigo">将至</span>
            <div class="ke-notice-body">
                <div class="ke-notice-title">回响已至 · 下一轮剧情将自然呈现</div>
                ${itemsHtml}
            </div>
        </div>`;
    }

    // 2. 角色卡
    let cardsHtml = '';
    if (chars.length === 0) {
        cardsHtml = `<div class="st-karma-empty-state">
            ${INK_MOUNTAIN_SVG}
            <div class="ke-empty-title">簿上尚无一笔</div>
            <div class="ke-empty-sub">推进剧情，或点击上方 <strong>「扫描世界书与前史」</strong>，<br/>让第一笔因果落墨。</div>
        </div>`;
    } else {
        cardsHtml = `<div class="st-karma-char-grid">${chars.map(c => {
            const r = charRoulettes[c.name];
            const tier = getKarmaTierInfo(c.totalKarma);
            const tone = karmaTone(c.totalKarma);
            const sealTone = tone === 'good' ? 'ke-seal-celadon' : (tone === 'evil' ? 'ke-seal-cinnabar' : 'ke-seal-neutral');
            const alertClass = r.triggerChance >= 50
                ? (r.dominantType === 'retribution' ? 'karma-card-evil-alert' : 'karma-card-good-alert')
                : '';

            // 因果秤：-100 ~ +100 映射到 0% ~ 100%
            const pos = Math.min(98, Math.max(2, 50 + (Number(c.totalKarma) || 0) / 2));
            const fillLeft = Math.min(50, pos);
            const fillWidth = Math.abs(pos - 50);
            const ticks = [0, 25, 50, 75, 100]
                .map(t => `<i class="ke-tick${t === 50 ? ' mid' : ''}" style="left:${t}%"></i>`)
                .join('');

            const seeds = (c.seeds || []).slice().reverse().slice(0, 8);
            const seedsHtml = seeds.length === 0
                ? `<div class="ke-empty-line">暂无伏笔</div>`
                : seeds.map(s => {
                    const sTone = s.delta > 0 ? 'good' : 'evil';
                    const waited = Math.max(0, currentTurn - (s.turn || 0));
                    const reqWait = s.minDelayTurns !== undefined ? s.minDelayTurns : settings.latentTurns;
                    const state = s.settled ? 'settled' : (waited >= reqWait ? 'mature' : 'latent');
                    const stateLabel = state === 'settled' ? '已结' : (state === 'mature' ? '待发' : `潜伏 ${waited}/${reqWait}`);
                    return `<div class="ke-seed ${sTone} ${state}">
                        <i class="ke-seed-dot"></i>
                        <div class="ke-seed-body">
                            <span class="ke-seed-turn">T${s.turn || 0}</span>${escapeHtml(s.deed)}${s.ruleRef ? `<span class="ke-muted"> · ${escapeHtml(s.ruleRef)}</span>` : ''}<span class="ke-seed-state">${stateLabel}</span>
                        </div>
                        <span class="ke-seed-delta">${formatKarma(s.delta)}</span>
                    </div>`;
                }).join('');

            const checkNote = r.inCooldown
                ? `冷却中，还需 ${r.cooldownRemaining} 回合`
                : (r.triggerChance > 0
                    ? `${r.dominantType === 'retribution' ? '报应' : '回馈'}池已蓄 ${r.dominantValue}，每回合自动检定`
                    : `酝酿中 · 已成熟 ${formatKarma(-r.matureEvil)} / ${formatKarma(r.matureGood)} · 潜伏 ${formatKarma(-r.latentEvil)} / ${formatKarma(r.latentGood)}`);

            return `<div class="st-karma-char-card ${alertClass}">
                <div class="ke-card-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</div>
                <div class="ke-card-main">
                    <div class="ke-card-head">
                        <div class="ke-card-score tone-${tone}">${formatKarma(c.totalKarma)}<span>${escapeHtml(tier.aura)}</span></div>
                        <span class="ke-seal ${sealTone}">${escapeHtml(tier.title)}</span>
                        <button class="ke-icon-btn st-karma-delete-char" data-char="${escapeHtml(c.name)}" title="移除该角色记录">✕</button>
                    </div>

                    <div class="ke-scale">
                        <div class="ke-scale-labels">
                            <span>负 ${c.evilAccumulated || 0}</span>
                            <span class="ke-scale-name">因果秤</span>
                            <span>正 ${c.goodAccumulated || 0}</span>
                        </div>
                        <div class="ke-scale-track tone-${tone}">
                            ${ticks}
                            <div class="ke-scale-fill" style="left:${fillLeft}%; width:${fillWidth}%;"></div>
                            <div class="ke-scale-weight" style="left:${pos}%;"></div>
                        </div>
                    </div>

                    <div class="ke-check">
                        <div class="ke-check-row">
                            <span>回响检定</span>
                            <span class="ke-check-val ${r.triggerChance > 0 ? '' : 'is-zero'}">${r.triggerChance}%</span>
                        </div>
                        <div class="ke-check-track"><div class="ke-check-fill" style="width:${r.triggerChance}%;"></div></div>
                        <div class="ke-check-note">${checkNote}</div>
                    </div>

                    <div class="ke-seeds">${seedsHtml}</div>

                    <div class="ke-card-actions">
                        <button class="st-karma-btn karma-btn-danger st-karma-force-retribution" data-char="${escapeHtml(c.name)}">触发报应</button>
                        <button class="st-karma-btn karma-btn-good st-karma-force-blessing" data-char="${escapeHtml(c.name)}">触发回馈</button>
                    </div>
                </div>
            </div>`;
        }).join('')}</div>`;
    }

    // 3. 因果流水
    const logsHtml = (ledger.historyLogs || []).slice(0, 20).map(log => {
        if (log.type === 'settlement') {
            const isRet = log.direction === 'retribution';
            return `<div class="ke-log ke-log-settle">
                <span class="ke-seal ke-seal-sm ${isRet ? 'ke-seal-cinnabar' : 'ke-seal-celadon'}">${isRet ? '报' : '馈'}</span>
                <span class="ke-log-turn">T${log.turn}</span>
                <div class="ke-log-text"><b>${escapeHtml(log.character)}</b> · ${escapeHtml(log.severityName)}<span class="ke-muted">　${escapeHtml(log.deedsText)}</span></div>
                <span class="ke-log-time">${escapeHtml(log.timestamp || '')}</span>
            </div>`;
        }
        const tone = log.delta > 0 ? 'good' : 'evil';
        return `<div class="ke-log">
            <i class="ke-log-dot tone-${tone}"></i>
            <span class="ke-log-turn">T${log.turn}</span>
            <div class="ke-log-text"><b>${escapeHtml(log.character)}</b> · ${escapeHtml(log.deed)}${log.ruleRef ? `<span class="ke-muted">（${escapeHtml(log.ruleRef)}）</span>` : ''}</div>
            <span class="ke-log-amt tone-${tone}">${formatKarma(log.delta)}</span>
        </div>`;
    }).join('') || '<div class="ke-empty-line">尚无流水</div>';

    const modeLabel = settings.judgeMode === 'hybrid'
        ? '混合'
        : (settings.judgeMode === 'inline' ? '内嵌' : '静默');

    bodyEl.innerHTML = `
        <div class="st-karma-status-banner">
            <div class="ke-stats">
                <div class="ke-stat"><span class="ke-stat-label">回合</span><span class="ke-stat-val">${currentTurn}</span></div>
                <div class="ke-stat"><span class="ke-stat-label">潜伏</span><span class="ke-stat-val">${settings.latentTurns}<span class="ke-stat-unit">回合</span></span></div>
                <div class="ke-stat"><span class="ke-stat-label">阈值</span><span class="ke-stat-val">±${settings.triggerThreshold}</span></div>
                <div class="ke-stat"><span class="ke-stat-label">判定</span><span class="ke-stat-val">${modeLabel}</span></div>
                <div class="ke-stat" title="距离下次后台判定还差几次 AI 回复"><span class="ke-stat-label">待判</span><span class="ke-stat-val">${settings.judgeMode === 'inline' ? '—' : `${ledger.repliesSinceJudge || 0}<span class="ke-stat-unit">/ ${Math.max(1, Number(settings.judgeInterval) || 1)}</span>`}</span></div>
            </div>
            <div class="st-karma-btn-bar">
                <button id="st-karma-btn-scan-lore" class="st-karma-btn karma-btn-primary">扫描世界书与前史</button>
                <button id="st-karma-btn-judge-now" class="st-karma-btn" title="立即判定上次判定之后的所有楼层（跳过隐藏楼层）">立即判定</button>
                <button id="st-karma-btn-roll-now" class="st-karma-btn">执行检定</button>
                <button id="st-karma-btn-reset-chat" class="st-karma-btn karma-btn-danger">重置</button>
            </div>
        </div>

        ${pendingHtml}

        ${cardsHtml}

        <div class="st-karma-section-title">手录一笔</div>
        <div class="st-karma-manual-form">
            <input id="st-karma-manual-char" type="text" placeholder="角色姓名" style="width:120px;" />
            <input id="st-karma-manual-delta" type="number" value="-25" step="5" title="正数为善因，负数为恶因" style="width:64px;" />
            <input id="st-karma-manual-deed" type="text" placeholder="所作所为（如：违背承诺暗中设局 / 危急关头挺身相助）" style="flex:1; min-width:200px;" />
            <input id="st-karma-manual-rule" type="text" placeholder="关联设定（选填）" style="width:130px;" />
            <input id="st-karma-manual-delay" type="number" value="${settings.latentTurns}" min="0" max="20" title="潜伏回合数" style="width:48px;" />
            <button id="st-karma-manual-add-btn" class="st-karma-btn karma-btn-primary">落笔</button>
        </div>

        <div class="st-karma-section-title">因果流水</div>
        <div class="st-karma-log-list">${logsHtml}</div>
    `;

    bindModalInnerEvents();
}

function bindModalInnerEvents() {
    const bodyEl = document.getElementById('st-karma-modal-body');
    if (!bodyEl) return;

    bodyEl.querySelector('#st-karma-btn-scan-lore')?.addEventListener('click', async () => {
        await scanWorldLoreForInitialKarma();
    });

    bodyEl.querySelector('#st-karma-btn-judge-now')?.addEventListener('click', async () => {
        await judgeLatestTurnWithAI(true);
        const ledger = getChatLedger();
        for (const c of Object.values(ledger.characters)) {
            calculateCharacterRoulette(c, ledger.turnCounter);
        }
        await saveChatLedger();
        syncExtensionPrompts();
        renderKarmaModalContent();
        updateFabBadge();
    });

    bodyEl.querySelector('#st-karma-btn-roll-now')?.addEventListener('click', async () => {
        const triggered = rollKarmaRouletteForAll();
        await saveChatLedger();
        syncExtensionPrompts();
        renderKarmaModalContent();
        updateFabBadge();
        if (typeof toastr !== 'undefined') {
            if (triggered.length > 0) {
                toastr.info(`检定命中 ${triggered.length} 位角色，将在下一回合触发因果回响。`, '因果回响');
            } else {
                toastr.info('本轮概率检定未触发（尚在潜伏期或未命中概率）。', '因果回响');
            }
        }
    });

    bodyEl.querySelector('#st-karma-btn-reset-chat')?.addEventListener('click', async () => {
        if (!confirm('确定要清空当前对话的所有角色因果档案与历史记录吗？')) return;
        const ctx = getSTContext();
        ctx.chatMetadata[MODULE_NAME] = createEmptyLedger();
        await saveChatLedger();
        syncExtensionPrompts();
        renderKarmaModalContent();
        updateFabBadge();
    });

    bodyEl.querySelector('#st-karma-manual-add-btn')?.addEventListener('click', async () => {
        const charName = bodyEl.querySelector('#st-karma-manual-char')?.value?.trim();
        const delta = Number(bodyEl.querySelector('#st-karma-manual-delta')?.value || 0);
        const deed = bodyEl.querySelector('#st-karma-manual-deed')?.value?.trim();
        const ruleRef = bodyEl.querySelector('#st-karma-manual-rule')?.value?.trim();
        const minDelayTurns = Number(bodyEl.querySelector('#st-karma-manual-delay')?.value ?? 3);

        if (!charName || !delta) {
            if (typeof toastr !== 'undefined') toastr.warning('请填写角色姓名与非零的分值变动。');
            return;
        }
        recordKarmaEvent(charName, delta, deed || (delta > 0 ? '手动记录正向事件' : '手动记录负面事件'), {
            ruleRef,
            minDelayTurns,
        });
        await saveChatLedger();
        syncExtensionPrompts();
        renderKarmaModalContent();
        updateFabBadge();
    });

    bodyEl.querySelectorAll('.st-karma-cancel-pending').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            const ledger = getChatLedger();
            ledger.pendingSettlements = (ledger.pendingSettlements || []).filter(p => p.id !== id);
            await saveChatLedger();
            syncExtensionPrompts();
            renderKarmaModalContent();
            updateFabBadge();
        });
    });

    bodyEl.querySelectorAll('.st-karma-delete-char').forEach(btn => {
        btn.addEventListener('click', async () => {
            const charName = btn.getAttribute('data-char');
            if (!charName) return;
            const ledger = getChatLedger();
            delete ledger.characters[charName];
            ledger.pendingSettlements = (ledger.pendingSettlements || []).filter(p => p.character !== charName);
            await saveChatLedger();
            syncExtensionPrompts();
            renderKarmaModalContent();
            updateFabBadge();
        });
    });

    const handleForceTrigger = async (charName, forcedDirection) => {
        const ledger = getChatLedger();
        const charRec = ledger.characters[charName];
        if (!charRec) return;

        const roulette = calculateCharacterRoulette(charRec, ledger.turnCounter);
        roulette.dominantType = forcedDirection;
        if (roulette.dominantValue < 25) {
            roulette.dominantValue = Math.max(35, Math.abs(charRec.totalKarma));
        }

        const directive = buildSettlementDirective(charRec, roulette, 1, true);
        directive.direction = forcedDirection;
        ledger.pendingSettlements = (ledger.pendingSettlements || []).filter(p => p.character !== charName);
        ledger.pendingSettlements.push(directive);

        await saveChatLedger();
        syncExtensionPrompts();
        renderKarmaModalContent();
        updateFabBadge();

        if (typeof toastr !== 'undefined') {
            toastr.success(
                `已为【${charName}】排入${forcedDirection === 'retribution' ? '负面报应' : '正向回馈'}指令，将在下一轮回复生效。`,
                '因果回响'
            );
        }
    };

    bodyEl.querySelectorAll('.st-karma-force-retribution').forEach(btn => {
        btn.addEventListener('click', () => handleForceTrigger(btn.getAttribute('data-char'), 'retribution'));
    });

    bodyEl.querySelectorAll('.st-karma-force-blessing').forEach(btn => {
        btn.addEventListener('click', () => handleForceTrigger(btn.getAttribute('data-char'), 'blessing'));
    });
}

/**
 * 初始化扩展抽屉、毛玻璃悬浮球与主面板
 */
function initUI() {
    const settings = getSettings();

    const settingsContainer = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (settingsContainer && !document.getElementById('st-karma-settings-drawer')) {
        const drawerHtml = `
        <div id="st-karma-settings-drawer" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>因果回响 (Karma Echo)</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="st-karma-settings-wrap">
                    <div class="st-karma-btn-bar">
                        <button id="st-karma-open-modal-btn" class="st-karma-btn karma-btn-primary" style="width:100%; justify-content:center; padding:8px;">
                            打开「因果回响」观测面板
                        </button>
                    </div>

                    <div class="st-karma-row">
                        <label><input id="st-karma-enabled" type="checkbox" ${settings.enabled ? 'checked' : ''} /> 启用因果回响追踪系统</label>
                    </div>
                    <div class="st-karma-row">
                        <label><input id="st-karma-show-fab" type="checkbox" ${settings.showFab ? 'checked' : ''} /> 显示右下角毛玻璃悬浮按钮</label>
                    </div>
                    <div class="st-karma-row">
                        <label><input id="st-karma-show-badge" type="checkbox" ${settings.showChatBadge ? 'checked' : ''} /> 在聊天气泡底部显示因果变动提示</label>
                    </div>

                    <div class="st-karma-section-title">识别与世界书判定</div>
                    <div class="st-karma-row">
                        <label>因果判定模式</label>
                        <select id="st-karma-judge-mode" class="text_pole" style="width:185px;">
                            <option value="hybrid" ${settings.judgeMode === 'hybrid' ? 'selected' : ''}>混合模式 (优先标签 / 兜底后台)</option>
                            <option value="inline" ${settings.judgeMode === 'inline' ? 'selected' : ''}>仅正文内嵌 &lt;karma&gt; 标签 (零消耗)</option>
                            <option value="quiet" ${settings.judgeMode === 'quiet' ? 'selected' : ''}>仅后台静默 API 独立判定</option>
                        </select>
                    </div>
                    <div class="st-karma-row">
                        <label><input id="st-karma-include-wi" type="checkbox" ${settings.includeWorldInfo ? 'checked' : ''} /> 结合世界书 (World Info) 与角色设定</label>
                    </div>
                    <div class="st-karma-row">
                        <small id="st-karma-wi-status" style="opacity:0.75; line-height:1.5;">自动读取酒馆每轮实际激活的世界书条目，无需配置关键词。</small>
                    </div>
                    <div class="st-karma-row">
                        <label title="每回合判定时，附带给模型的世界书内容上限">每回合世界书字数上限</label>
                        <input id="st-karma-wi-chars" type="number" min="500" max="20000" step="500" class="text_pole st-karma-input-num" value="${settings.maxWorldInfoChars}" />
                    </div>
                    <div class="st-karma-row">
                        <label title="点「扫描世界书与前史」时，交给模型通读的世界书内容上限">开局扫描字数上限</label>
                        <input id="st-karma-scan-chars" type="number" min="1000" max="60000" step="1000" class="text_pole st-karma-input-num" value="${settings.scanWorldInfoChars}" />
                    </div>
                    <div class="st-karma-row">
                        <label title="混合/后台模式下，每累计 N 次 AI 回复做一次判定，一次性读取上次判定之后的所有楼层">每几次 AI 回复判定一次</label>
                        <input id="st-karma-judge-interval" type="number" min="1" max="50" class="text_pole st-karma-input-num" value="${settings.judgeInterval}" />
                    </div>
                    <div class="st-karma-row">
                        <label title="单次判定最多读取的剧情字数，超出时优先保留最新楼层">单次判定读取字数上限</label>
                        <input id="st-karma-judge-chars" type="number" min="1000" max="60000" step="1000" class="text_pole st-karma-input-num" value="${settings.judgeMaxChars}" />
                    </div>
                    <div class="st-karma-row">
                        <small style="opacity:0.75; line-height:1.5;">被总结插件或手动隐藏（👻）的楼层会自动跳过，不参与判定。</small>
                    </div>

                    <div class="st-karma-section-title">延时检定与触发参数</div>
                    <div class="st-karma-row">
                        <label title="事件发生后至少等待几回合才进入检定池">伏笔潜伏期 (回合)</label>
                        <input id="st-karma-latent-turns" type="number" min="0" max="20" class="text_pole st-karma-input-num" value="${settings.latentTurns}" />
                    </div>
                    <div class="st-karma-row">
                        <label title="已过潜伏期的累积值达到多少分开始概率检定">起检阈值 (分值)</label>
                        <input id="st-karma-threshold" type="number" min="5" max="200" step="5" class="text_pole st-karma-input-num" value="${settings.triggerThreshold}" />
                    </div>
                    <div class="st-karma-row">
                        <label title="刚达阈值时的基础触发概率 (%)">达标基础触发率 (%)</label>
                        <input id="st-karma-base-chance" type="number" min="1" max="100" class="text_pole st-karma-input-num" value="${settings.baseTriggerChance}" />
                    </div>
                    <div class="st-karma-row">
                        <label title="每多拖延1回合额外递增的概率 (%)">每回合递增触发率 (%)</label>
                        <input id="st-karma-turn-weight" type="number" min="0" max="50" class="text_pole st-karma-input-num" value="${settings.turnWeight}" />
                    </div>
                    <div class="st-karma-row">
                        <label title="两次触发之间的最短冷却回合">触发冷却期 (回合)</label>
                        <input id="st-karma-cooldown" type="number" min="0" max="20" class="text_pole st-karma-input-num" value="${settings.cooldownTurns}" />
                    </div>
                    <div class="st-karma-row">
                        <label title="导演指令注入深度 (@D)">指令注入深度 (@D)</label>
                        <input id="st-karma-inject-depth" type="number" min="0" max="10" class="text_pole st-karma-input-num" value="${settings.injectDepth}" />
                    </div>

                    <div class="st-karma-section-title">独立副模型 API (可选)</div>
                    <div class="st-karma-row">
                        <label><input id="st-karma-custom-api" type="checkbox" ${settings.useCustomApi ? 'checked' : ''} /> 启用独立 OpenAI 兼容 API 进行后台分析</label>
                    </div>
                    <div id="st-karma-custom-api-box" style="display:${settings.useCustomApi ? 'flex' : 'none'}; flex-direction:column; gap:6px;">
                        <input id="st-karma-api-url" type="text" class="text_pole" placeholder="API 地址 (如 https://api.openai.com/v1)" value="${escapeHtml(settings.customApiUrl)}" />
                        <input id="st-karma-api-key" type="password" class="text_pole" placeholder="API Key (sk-...)" value="${escapeHtml(settings.customApiKey)}" />
                        <input id="st-karma-api-model" type="text" class="text_pole" placeholder="模型名称 (如 gpt-4o-mini / deepseek-chat)" value="${escapeHtml(settings.customApiModel)}" />
                    </div>
                </div>
            </div>
        </div>`;

        settingsContainer.insertAdjacentHTML('beforeend', drawerHtml);
        bindSettingsEvents();
    }

    if (!document.getElementById('st-karma-fab')) {
        const fab = document.createElement('div');
        fab.id = 'st-karma-fab';
        fab.title = '因果回响 · Karma Echo';
        fab.innerHTML = `<span class="ke-fab-char">因</span><span class="karma-fab-badge" style="display:none;">0</span>`;
        fab.addEventListener('click', openKarmaModal);
        document.body.appendChild(fab);
    }

    if (!document.getElementById('st-karma-modal-backdrop')) {
        const modalBackdrop = document.createElement('div');
        modalBackdrop.id = 'st-karma-modal-backdrop';
        modalBackdrop.innerHTML = `
            <div class="st-karma-modal">
                <div class="st-karma-modal-header">
                    ${INK_MOUNTAIN_SVG}
                    <div class="st-karma-modal-brand">
                        ${BRAND_SEAL_HTML}
                        <div>
                            <div class="st-karma-modal-title">
                                因果回响
                                <span class="st-karma-modal-title-en">Karma Echo</span>
                            </div>
                            <div class="st-karma-modal-subtitle">凡有所为 · 皆有回响</div>
                        </div>
                    </div>
                    <div class="ke-header-right">
                        <div class="ke-vertical-note">延时因果<br/>剧情回旋</div>
                        <button id="st-karma-modal-close" class="st-karma-btn ke-close-btn" title="关闭">✕</button>
                    </div>
                </div>
                <div id="st-karma-modal-body" class="st-karma-modal-body"></div>
            </div>
        `;
        modalBackdrop.addEventListener('click', (e) => {
            if (e.target === modalBackdrop) closeKarmaModal();
        });
        document.body.appendChild(modalBackdrop);
        document.getElementById('st-karma-modal-close')?.addEventListener('click', closeKarmaModal);
    }

    updateFabBadge();
}

function bindSettingsEvents() {
    const settings = getSettings();

    document.getElementById('st-karma-open-modal-btn')?.addEventListener('click', openKarmaModal);

    const bindCheck = (id, key) => {
        document.getElementById(id)?.addEventListener('change', (e) => {
            settings[key] = Boolean(e.target.checked);
            saveSettings();
            syncExtensionPrompts();
            updateFabBadge();
            if (key === 'useCustomApi') {
                const box = document.getElementById('st-karma-custom-api-box');
                if (box) box.style.display = settings.useCustomApi ? 'flex' : 'none';
            }
        });
    };

    const bindVal = (id, key, isNum = false) => {
        document.getElementById(id)?.addEventListener('change', (e) => {
            settings[key] = isNum ? Number(e.target.value) : String(e.target.value).trim();
            saveSettings();
            syncExtensionPrompts();
        });
    };

    bindCheck('st-karma-enabled', 'enabled');
    bindCheck('st-karma-show-fab', 'showFab');
    bindCheck('st-karma-show-badge', 'showChatBadge');
    bindCheck('st-karma-include-wi', 'includeWorldInfo');
    bindCheck('st-karma-custom-api', 'useCustomApi');

    bindVal('st-karma-judge-mode', 'judgeMode', false);
    bindVal('st-karma-wi-chars', 'maxWorldInfoChars', true);
    bindVal('st-karma-scan-chars', 'scanWorldInfoChars', true);
    bindVal('st-karma-judge-interval', 'judgeInterval', true);
    bindVal('st-karma-judge-chars', 'judgeMaxChars', true);
    bindVal('st-karma-latent-turns', 'latentTurns', true);
    bindVal('st-karma-threshold', 'triggerThreshold', true);
    bindVal('st-karma-base-chance', 'baseTriggerChance', true);
    bindVal('st-karma-turn-weight', 'turnWeight', true);
    bindVal('st-karma-cooldown', 'cooldownTurns', true);
    bindVal('st-karma-inject-depth', 'injectDepth', true);

    bindVal('st-karma-api-url', 'customApiUrl', false);
    bindVal('st-karma-api-key', 'customApiKey', false);
    bindVal('st-karma-api-model', 'customApiModel', false);
}

jQuery(async () => {
    try {
        initUI();
        syncExtensionPrompts();

        const ctx = getSTContext();
        const evSource = ctx.eventSource;
        const evTypes = ctx.event_types || {};

        if (evSource && typeof evSource.on === 'function') {
            if (evTypes.CHAT_CHANGED) {
                evSource.on(evTypes.CHAT_CHANGED, () => {
                    lastActivatedWorldInfo = [];
                    updateWorldInfoStatus();
                    syncExtensionPrompts();
                    updateFabBadge();
                    renderModalIfOpen();
                });
            }

            if (evTypes.WORLD_INFO_ACTIVATED) {
                evSource.on(evTypes.WORLD_INFO_ACTIVATED, onWorldInfoActivated);
            }

            if (evTypes.MESSAGE_RECEIVED) {
                evSource.on(evTypes.MESSAGE_RECEIVED, async (messageId) => {
                    await onMessageReceived(messageId);
                });
            }

            const beforeGenEvents = [
                evTypes.GENERATE_BEFORE_COMBINE_PROMPTS,
                evTypes.CHAT_COMPLETION_PROMPT_READY,
            ].filter(Boolean);

            for (const evName of beforeGenEvents) {
                evSource.on(evName, () => {
                    syncExtensionPrompts();
                });
            }
        }

        console.log('[因果回响 (Karma Echo)] 插件已加载完毕');
    } catch (err) {
        console.error('[因果回响 (Karma Echo)] 初始化失败:', err);
    }
});
