import {
    Widget,
    type WidgetProps,
    type WidgetPlacement
} from '@deck.gl/core';

export type CustomIconWidgetProps = WidgetProps & {
    id?: string;
    placement?: WidgetPlacement;
    viewId?: string | null;

    /** The tooltip to display on hover. */
    title: string;
    
    /** The click event handler. */
    onClick: (event: MouseEvent) => void;
    
    /** * The CSS class name for the <button> element.
     * This is what you will target in your CSS to assign an icon.
     */
    iconClassName: string;
    iconName: string;
    
    /** An optional CSS class for the widget's root <div> container. */
    className?: string; 
};

export class CustomIconWidget extends Widget<CustomIconWidgetProps> {
    
    static defaultProps: Required<CustomIconWidgetProps> = {
        ...Widget.defaultProps,
        id: 'custom-icon-widget',
        placement: 'top-left',
        viewId: null,
        title: 'Custom Action',
        onClick: () => {},
        iconClassName: 'my-custom-widget-button', // Default button class
        iconName: 'info',
        className: 'my-custom-widget' // Default widget container class
    };
    
    placement: WidgetPlacement;
    className: string;
    /**
     * A reference to the button element.
     * We create this in onAdd and update it in onRenderHTML.
     */
    private buttonElement: HTMLButtonElement | null = null;

    constructor(props: CustomIconWidgetProps) {
        super(props);
        this.placement = this.props.placement;
        this.className = this.props.className!;
    }
    /**
     * Called when the widget is added to the Deck instance.
     * Creates the widget's root DOM element.
     */
    onAdd() {
        const container = document.createElement('div');
        container.className = `deck-widget ${this.props.className}`;

        const subcontainer = document.createElement('div');
        subcontainer.className = `deck-widget-button`;
        
        this.buttonElement = document.createElement('button');
        this.buttonElement.type = 'button';

        const iconSpan = document.createElement('div');
        iconSpan.className = 'deck-widget-icon material-symbols-outlined';
        iconSpan.textContent = this.props.iconName


        this.buttonElement.appendChild(iconSpan);
        subcontainer.appendChild(this.buttonElement)
        container.appendChild(subcontainer);

        this.updateHTML(); 
        
        return container;
    }

    /**
     * Called by updateHTML() to refresh the widget's content.
     * This is where we update the DOM based on the current props.
     */
    onRenderHTML() {
        // onAdd guarantees this.buttonElement is set
        if (!this.buttonElement) {
            return;
        }

        // Apply all dynamic props to the button
        this.buttonElement.className = this.props.iconClassName;
        this.buttonElement.title = this.props.title;
        this.buttonElement.setAttribute('aria-label', this.props.title);
        this.buttonElement.onclick = this.props.onClick;

        // Update the icon name if the props changed
        const iconSpan = this.buttonElement.querySelector<HTMLElement>('.deck-widget-icon');
        if(iconSpan && iconSpan.textContent !== this.props.iconName) {
            iconSpan.textContent = this.props.iconName;
        }
    }

    /**
     * Called when setProps is called. Merges new props
     * and triggers a re-render.
     */
    setProps(props: Partial<CustomIconWidgetProps>) {
        // Update placement and viewId if provided
        this.placement = props.placement ?? this.placement;
        this.viewId = props.viewId ?? this.viewId;
        
        // Call super.setProps to merge props and trigger updateHTML()
        super.setProps(props);

        // Update container class if provided
        if (this.rootElement && props.className) {
        this.rootElement.className = `deck-widget ${props.className}`;
        }
    }
}