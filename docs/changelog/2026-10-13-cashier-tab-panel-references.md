# Cashier tab references follow mounted panels

The production Cashier certificate in run 38430543068 failed its Advanced Cashier accessibility check because an inactive Send tab referenced an unmounted panel. Cashier mounts only the selected, authorized action panel. Tabs now expose aria-controls only for that mounted panel after the role is known, while existing labels, keyboard navigation, forms and authorization remain unchanged.

Two tests in the maintained mounted Cashier launch suite cover every action change and pending role hydration. They fail on the unchanged source and require the selected panel reference and reciprocal label to resolve, with no dangling references on inactive or loading tabs. No financial request is submitted. Existing production Cashier Axe assertions remain enforced.

Required checks, protected merge, the existing client publisher, both public build-info endpoints and actual Cashier certificate/cleanup evidence remain necessary before completion.
