import * as Primitive from '@radix-ui/react-popover';
import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef } from 'react';

export const Popover = Primitive.Root;
export const PopoverTrigger = Primitive.Trigger;
export const PopoverClose = Primitive.Close;
export const PopoverContent = forwardRef<ComponentRef<typeof Primitive.Content>, ComponentPropsWithoutRef<typeof Primitive.Content>>(
  function PopoverContent({className='', align='end', sideOffset=10, ...props},ref) {
    return <Primitive.Portal><Primitive.Content ref={ref} align={align} sideOffset={sideOffset} collisionPadding={12}
      className={'nav-popover ' + className} {...props}/></Primitive.Portal>;
  }
);
