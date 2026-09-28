const MODULE_ID = "pf2e-roll-range";


/**
 * Returns true if the message was rolled by a player character.
 */
function isPlayerCharacterMessage(message) {
    return message.speakerActor?.type === "character";
}


/**
 * PF2e damage rolls expose their damage components as instances.
 */
function isDamageRoll(roll) {
    return Array.isArray(roll.instances) && roll.instances.length > 0;
}


/**
 * Calculates the range of a PF2e damage roll.
 * Persistent damage is excluded since it isn't part of the immediate damage.
 */
function calculateDamageRange(roll) {
    const instances = roll.instances.filter(instance => !instance.persistent);

    // Don't add a range to rolls that contain only persistent damage.
    if (instances.length === 0) {
        return null;
    }

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
        console.error("PF2e Roll Range | Failed to calculate damage range.");
        return null;
    }

    return { min, average, max };
}


Hooks.on("createChatMessage", async message => {
    if (!message.rolls?.length || !isPlayerCharacterMessage(message)) {
        return;
    }

    const roll = message.rolls[0];

    if (!isDamageRoll(roll)) {
        return;
    }

    const range = calculateDamageRange(roll);

    if (!range) {
        return;
    }

    await message.setFlag(MODULE_ID, "range", range);
});


Hooks.on("renderChatMessage", (message, html) => {
    const range = message.getFlag(MODULE_ID, "range");

    if (!range) {
        return;
    }

    const root = html instanceof HTMLElement ? html : html?.[0];

    if (!root || root.querySelector(".pf2e-roll-range")) {
        return;
    }

    const rangeElement = document.createElement("div");
    rangeElement.classList.add("pf2e-roll-range");

    rangeElement.innerHTML = `
        <div class="pf2e-roll-range-values">
            <div class="pf2e-roll-range-value">
                <div class="pf2e-roll-range-label">Min</div>
                <div class="pf2e-roll-range-number">${range.min}</div>
            </div>

            <div class="pf2e-roll-range-value">
                <div class="pf2e-roll-range-label">Average</div>
                <div class="pf2e-roll-range-number">${range.average}</div>
            </div>

            <div class="pf2e-roll-range-value">
                <div class="pf2e-roll-range-label">Max</div>
                <div class="pf2e-roll-range-number">${range.max}</div>
            </div>
        </div>
    `;

    root.appendChild(rangeElement);
});