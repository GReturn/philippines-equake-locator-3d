import {
    Widget,
    type WidgetProps,
    type WidgetPlacement
} from '@deck.gl/core';

/**
 * Defines the properties for a single button within the group.
 */
export type ButtonDefinition = {
    /** A unique ID for this button. */
    id: string;
    /** The tooltip to display on hover. */
    title: string;
    /** The Google Material Symbol name (e.g., 'history', 'add'). */
    iconName: string;
    /** The click event handler. */
    onClick: (event: MouseEvent) => void;
};

export type IconButtonGroupWidgetProps = WidgetProps & {
    id?: string;
    placement?: WidgetPlacement;
    viewId?: string | null;

    /** The array of buttons to render in the group. */
    buttons: ButtonDefinition[];

    /** The orientation of the button group. */
    orientation?: 'vertical' | 'horizontal';
    
    /** An optional CSS class for the widget's root <div> container. */
    className?: string; 
    };

    export class IconButtonGroupWidget extends Widget<IconButtonGroupWidgetProps> {
    
    static defaultProps: Required<IconButtonGroupWidgetProps> = {
        ...Widget.defaultProps,
        id: 'custom-icon-group-widget',
        placement: 'top-left',
        viewId: null,
        buttons: [],
        orientation: 'vertical',
        className: 'my-custom-group' // Custom class for the root
    };
    
    placement: WidgetPlacement;
    className: string;

    /**
     * A reference to the <div> that holds the button wrappers.
     * e.g., <div class="deck-widget-button-group vertical">
     */
    private buttonGroupContainer: HTMLDivElement | null = null;

    constructor(props: IconButtonGroupWidgetProps) {
        super(props);
        this.placement = this.props.placement;
        this.className = this.props.className!;
    }

    /**
     * Called when the widget is added. Creates the static containers.
     */
    onAdd() {
        // 1. Create the root <div> container
        const container = document.createElement('div');
        container.className = `deck-widget ${this.className}`; 
        
        // 2. Create the group container <div>
        this.buttonGroupContainer = document.createElement('div');
        this.buttonGroupContainer.className = `deck-widget-button-group ${this.props.orientation}`;

        // 3. Append group container to root container
        container.appendChild(this.buttonGroupContainer);

        // Call updateHTML() to trigger the first onRenderHTML
        this.updateHTML(); 
        
        return container;
    }

    /**
   * Called by updateHTML() to build/re-build the buttons.
   * This version is non-destructive to avoid event conflicts.
   */
    onRenderHTML() {
        if (!this.buttonGroupContainer) {
            return;
        }

        const { buttons } = this.props;

        // Get all current button wrappers (div.deck-widget-button)
        const existingWrappers = Array.from(
            this.buttonGroupContainer.querySelectorAll<HTMLDivElement>('.deck-widget-button')
        );

        // 1. Update or create buttons based on props
        buttons.forEach((buttonDef, index) => {
            const wrapper = existingWrappers[index];

            if (wrapper) {
                // --- A wrapper for this index already exists, just UPDATE it ---
                const buttonEl = wrapper.querySelector<HTMLButtonElement>('button');
                const iconEl = wrapper.querySelector<HTMLElement>('.deck-widget-icon');

                if (buttonEl && iconEl) {
                    // Update button properties
                    buttonEl.title = buttonDef.title;
                    buttonEl.setAttribute('aria-label', buttonDef.title);
                    buttonEl.onclick = buttonDef.onClick;
                    
                    // Update icon name only if it changed
                    if (iconEl.textContent !== buttonDef.iconName) {
                        iconEl.textContent = buttonDef.iconName;
                    }
                }
            } 
            else {
                // --- This button is NEW, so CREATE and APPEND it ---
                const buttonWrapper = document.createElement('div');
                buttonWrapper.className = 'deck-widget-button';
                
                const buttonEl = document.createElement('button');
                buttonEl.type = 'button';
                buttonEl.title = buttonDef.title;
                buttonEl.setAttribute('aria-label', buttonDef.title);
                buttonEl.onclick = buttonDef.onClick;

                const iconEl = document.createElement('div');
                iconEl.className = 'deck-widget-icon material-symbols-outlined';
                iconEl.textContent = buttonDef.iconName;

                buttonEl.appendChild(iconEl);
                buttonWrapper.appendChild(buttonEl);
                this.buttonGroupContainer!.appendChild(buttonWrapper);
            }
        });

        // 2. Remove any extra wrappers that are no longer in props
        if (existingWrappers.length > buttons.length) {
            for (let i = buttons.length; i < existingWrappers.length; i++) {
                existingWrappers[i].remove();
            }
        }
    } 

    /**
     * Called when setProps is called.
     */
    setProps(props: Partial<IconButtonGroupWidgetProps>) {
        // Update placement and viewId
        this.placement = props.placement ?? this.placement;
        this.viewId = props.viewId ?? this.viewId;
        
        // Call super.setProps to merge props and trigger updateHTML()
        super.setProps(props);

        // Update root container class if needed
        if (this.rootElement && props.className) {
            this.className = props.className;
            this.rootElement.className = `deck-widget ${this.className}`;
        }

        // Update group container orientation if needed
        if (this.buttonGroupContainer && props.orientation) {
            this.buttonGroupContainer.className = `deck-widget-button-group ${props.orientation}`;
        }
    }
}