const MODULE_ID = "pf2e-roll-range";

Hooks.once("init", () => {
    game.settings.register(MODULE_ID, "damageRangeMode", {
        name: "Damage Range Mode",
        hint: "Choose whether damage ranges use the basic roll values or account for a targeted creature's immunities, weaknesses, and resistances.",
        scope: "world",
        config: true,
        type: String,
        choices: {
            basic: "Basic",
            target: "Target IWR"
        },
        default: "basic"
    });
});

function isDamageRoll(roll) {
    return Array.isArray(roll.instances) && roll.instances.length > 0;
}

function getSingleTargetActor() {
    const targets = Array.from(game.user.targets);
    if (targets.length !== 1) return null;

    return targets[0].actor ?? null;
}

function getInstanceStatements(instance, message) {
    const statements = new Set(
        message.flags?.pf2e?.context?.options ?? []
    );

    for (const statement of instance.formalDescription ?? []) {
        statements.add(statement);
    }

    return statements;
}

function hasMatchingImmunity(actor, statements) {
    const immunities = actor?.system?.attributes?.immunities ?? [];

    return immunities.some(immunity => {
        try {
            return immunity.test(statements);
        } catch {
            return false;
        }
    });
}

function getMatchingResistance(actor, statements) {
    const resistances = actor?.system?.attributes?.resistances ?? [];

    const matching = resistances.filter(resistance => {
        try {
            return resistance.test(statements);
        } catch {
            return false;
        }
    });

    if (matching.length === 0) return 0;

    return Math.max(
        ...matching.map(resistance => Number(resistance.value) || 0)
    );
}

function getMatchingWeakness(actor, statements, usedApplyOnceWeaknesses) {
    const weaknesses = actor?.system?.attributes?.weaknesses ?? [];

    const matching = weaknesses
        .filter(weakness => {
            try {
                return weakness.test(statements);
            } catch {
                return false;
            }
        })
        .filter(weakness => {
            return !weakness.applyOnce ||
                !usedApplyOnceWeaknesses.has(weakness);
        })
        .sort((a, b) => {
            return (Number(b.value) || 0) - (Number(a.value) || 0);
        });

    const weakness = matching[0] ?? null;

    if (weakness?.applyOnce) {
        usedApplyOnceWeaknesses.add(weakness);
    }

    return Number(weakness?.value) || 0;
}

function calculateBasicRange(roll) {
    const instances = roll.instances.filter(instance => !instance.persistent);
    if (instances.length === 0) return null;

    const min = instances.reduce(
        (total, instance) => total + Number(instance.minimumValue),
        0
    );

    const average = instances.reduce(
        (total, instance) => total + Number(instance.expectedValue),
        0
    );

    const max = instances.reduce(
        (total, instance) => total + Number(instance.maximumValue),
        0
    );

    if (
        !Number.isFinite(min) ||
        !Number.isFinite(average) ||
        !Number.isFinite(max)
    ) {
        return null;
    }

    return { min, average, max };
}

function buildDiceDistribution(dice) {
    let distribution = new Map([[0, 1]]);

    for (const die of dice) {
        const number = Number(die.number);
        const faces = Number(die.faces);

        if (
            !Number.isInteger(number) ||
            !Number.isInteger(faces) ||
            number < 1 ||
            faces < 1
        ) {
            return null;
        }

        for (let dieNumber = 0; dieNumber < number; dieNumber++) {
            const next = new Map();

            for (const [currentTotal, probability] of distribution) {
                for (let result = 1; result <= faces; result++) {
                    const newTotal = currentTotal + result;
                    const newProbability = probability / faces;

                    next.set(
                        newTotal,
                        (next.get(newTotal) ?? 0) + newProbability
                    );
                }
            }

            distribution = next;
        }
    }

    return distribution;
}

function calculateResistedInstance(instance, resistance) {
    if (resistance <= 0) {
        return {
            min: Number(instance.minimumValue),
            average: Number(instance.expectedValue),
            max: Number(instance.maximumValue)
        };
    }

    const dice = Array.from(instance.dice ?? []);
    const distribution = buildDiceDistribution(dice);

    if (!distribution) return null;

    const diceMinimum = dice.reduce(
        (total, die) => total + Number(die.number),
        0
    );

    const flatModifier =
        Number(instance.minimumValue) - diceMinimum;

    let min = Infinity;
    let max = -Infinity;
    let average = 0;

    for (const [diceTotal, probability] of distribution) {
        const rawDamage = diceTotal + flatModifier;
        const finalDamage = Math.max(
            0,
            rawDamage - resistance
        );

        min = Math.min(min, finalDamage);
        max = Math.max(max, finalDamage);
        average += finalDamage * probability;
    }

    if (
        !Number.isFinite(min) ||
        !Number.isFinite(average) ||
        !Number.isFinite(max)
    ) {
        return null;
    }

    return { min, average, max };
}

function calculateTargetRange(roll, actor, message) {
    const instances = roll.instances.filter(instance => !instance.persistent);
    if (instances.length === 0) return null;

    const usedApplyOnceWeaknesses = new Set();

    let min = 0;
    let average = 0;
    let max = 0;

    for (const instance of instances) {
        const statements = getInstanceStatements(instance, message);

        if (hasMatchingImmunity(actor, statements)) {
            continue;
        }

        const resistance = getMatchingResistance(actor, statements);

        const weakness = getMatchingWeakness(
            actor,
            statements,
            usedApplyOnceWeaknesses
        );

        const adjusted = calculateResistedInstance(
            instance,
            resistance
        );

        if (!adjusted) {
            min += Number(instance.minimumValue) + weakness;
            average += Number(instance.expectedValue) + weakness;
            max += Number(instance.maximumValue) + weakness;
            continue;
        }

        min += adjusted.min + weakness;
        average += adjusted.average + weakness;
        max += adjusted.max + weakness;
    }

    if (
        !Number.isFinite(min) ||
        !Number.isFinite(average) ||
        !Number.isFinite(max)
    ) {
        return null;
    }

    return { min, average, max };
}

function formatNumber(value) {
    if (Number.isInteger(value)) return String(value);

    return String(
        Math.round(value * 100) / 100
    );
}

Hooks.on("createChatMessage", async message => {
    if (!message.rolls?.length) return;

    const roll = message.rolls[0];
    if (!isDamageRoll(roll)) return;

    const mode = game.settings.get(
        MODULE_ID,
        "damageRangeMode"
    );

    const target =
        mode === "target"
            ? getSingleTargetActor()
            : null;

    const range = target
        ? calculateTargetRange(roll, target, message)
        : calculateBasicRange(roll);

    if (!range) return;

    await message.setFlag(MODULE_ID, "range", range);
});

Hooks.on("renderChatMessage", (message, html) => {
    const range = message.getFlag(MODULE_ID, "range");
    if (!range) return;

    const root =
        html instanceof HTMLElement
            ? html
            : html?.[0];

    if (
        !root ||
        root.querySelector(".pf2e-roll-range")
    ) {
        return;
    }

    const rangeElement =
        document.createElement("div");

    rangeElement.classList.add(
        "pf2e-roll-range"
    );

    rangeElement.innerHTML = `
        <div class="pf2e-roll-range-values">
            <div class="pf2e-roll-range-value">
                <div class="pf2e-roll-range-label">Min</div>
                <div class="pf2e-roll-range-number">${formatNumber(range.min)}</div>
            </div>

            <div class="pf2e-roll-range-value">
                <div class="pf2e-roll-range-label">Average</div>
                <div class="pf2e-roll-range-number">${formatNumber(range.average)}</div>
            </div>

            <div class="pf2e-roll-range-value">
                <div class="pf2e-roll-range-label">Max</div>
                <div class="pf2e-roll-range-number">${formatNumber(range.max)}</div>
            </div>
        </div>
    `;

    root.appendChild(rangeElement);
});