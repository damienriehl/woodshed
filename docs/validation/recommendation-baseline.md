# Draft-setlist recommendation baseline

These thresholds were declared before representative-event tuning. The first algorithm (`draft-setlist/v1`) is intentionally transparent: normalized ballot demand and separately configured feasibility contribute to a deterministic score; missing feasibility remains `unknown`, never zero.

For graduation beyond preview, representative synthetic and authorized private validation must show:

- at least 70% of organizers accept the generated top five without removing more than one song;
- median organizer override burden is at most 25% of recommended positions;
- at least 80% of tested organizers correctly identify the leading recommendation factors from the explanation;
- identical algorithm version, configuration, seed, and input snapshot produce identical output;
- cohorts below three participants expose neither aggregate totals nor recommendation demand detail.

These are provisional product-validation gates, not claims of current performance. U8 owns measurement and any documented threshold revision before production graduation.
